/**
 * Telnet server implementation.
 *
 * References:
 *  - http://tools.ietf.org/html/rfc854
 *  - http://support.microsoft.com/kb/231866
 *  - http://www.iana.org/assignments/telnet-options
 *
 */

// export the "telnet" convenience function directly
module.exports = exports = telnet;

var assert  = require('assert'),
    debug   = require('debug')('telnet'),
    Stream  = require('stream'),
    Buffers = require('buffers'),
    Binary  = require('binary');

var COMMANDS = {
  SE:   240, // end of subnegotiation parameters
  NOP:  241, // no operation
  DM:   242, // data mark
  BRK:  243, // break
  IP:   244, // suspend (a.k.a. "interrupt process")
  AO:   245, // abort output
  AYT:  246, // are you there?
  EC:   247, // erase character
  EL:   248, // erase line
  GA:   249, // go ahead
  SB:   250, // subnegotiation
  WILL: 251, // will
  WONT: 252, // wont
  DO:   253, // do
  DONT: 254, // dont
  IAC:  255 // interpret as command
};

var OPTIONS = {
  TRANSMIT_BINARY:       0,        // http://tools.ietf.org/html/rfc856
  ECHO:                  1,                   // http://tools.ietf.org/html/rfc857
  SUPPRESS_GO_AHEAD:     3,      // http://tools.ietf.org/html/rfc858
  STATUS:                5,                 // http://tools.ietf.org/html/rfc859
  TIMING_MARK:           6,            // http://tools.ietf.org/html/rfc860
  TERMINAL_TYPE:         24,         // http://tools.ietf.org/html/rfc1091
  WINDOW_SIZE:           31,           // http://tools.ietf.org/html/rfc1073
  TERMINAL_SPEED:        32,        // http://tools.ietf.org/html/rfc1079
  REMOTE_FLOW_CONTROL:   33,   // http://tools.ietf.org/html/rfc1372
  LINEMODE:              34,              // http://tools.ietf.org/html/rfc1184
  X_DISPLAY_LOCATION:    35,    // http://tools.ietf.org/html/rfc1096
  AUTHENTICATION:        37,        // http://tools.ietf.org/html/rfc2941
  ENVIRONMENT_VARIABLES: 39  // http://tools.ietf.org/html/rfc1572
};

var IAC_BUF = new Buffer([COMMANDS.IAC]);

var COMMAND_NAMES = Object.keys(COMMANDS).reduce(function (names, name) {
  names[COMMANDS[name]] = name.toLowerCase();
  return names;
}, {});

var OPTION_NAMES = Object.keys(OPTIONS).reduce(function (names, name) {
  names[OPTIONS[name]] = name.toLowerCase().replace(/_/g, ' ');
  return names;
}, {});


var COMMAND_IMPLS = {}
;['do','dont','will','wont','sb'].forEach(function (command) {
  var code = COMMANDS[command.toUpperCase()];
  COMMAND_IMPLS[code] = function (bufs, i, event) {
    // needs to read 1 byte, for the command
    //console.error(command, bufs)
    if (bufs.length < (i + 1)) return MORE;
    return parseOption(bufs, i, event);
  };
});

// IAC
//   this will happen in "binary" mode, two IAC bytes needs to be translated
//   into 1 "data" event with a 1-length Buffer of value 255.
COMMAND_IMPLS[COMMANDS.IAC] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer();
  event.data = Buffer([255]);
  return event;
};


var OPTION_IMPLS = {};
// these ones don't take any arguments
OPTION_IMPLS.NO_ARGS =
OPTION_IMPLS[OPTIONS.ECHO] =
OPTION_IMPLS[OPTIONS.STATUS] =
OPTION_IMPLS[OPTIONS.LINEMODE] =
OPTION_IMPLS[OPTIONS.TRANSMIT_BINARY] =
OPTION_IMPLS[OPTIONS.AUTHENTICATION] =
OPTION_IMPLS[OPTIONS.TERMINAL_SPEED] =
OPTION_IMPLS[OPTIONS.TERMINAL_TYPE] =
OPTION_IMPLS[OPTIONS.REMOTE_FLOW_CONTROL] =
OPTION_IMPLS[OPTIONS.ENVIRONMENT_VARIABLES] =
OPTION_IMPLS[OPTIONS.X_DISPLAY_LOCATION] =
OPTION_IMPLS[OPTIONS.SUPPRESS_GO_AHEAD] = function (bufs, i, event) {
  event.buf = bufs.splice(0, i).toBuffer();
  return event;
};

OPTION_IMPLS[OPTIONS.WINDOW_SIZE] = function (bufs, i, event) {
  if (event.commandCode !== COMMANDS.SB) {
    OPTION_IMPLS.NO_ARGS(bufs, i, event);
  } else {
    // receiving a "resize" event
    if (bufs.length < 9) return MORE;
    event.buf = bufs.splice(0, 9).toBuffer();
    Binary.parse(event.buf)
      .word8('iac1')
      .word8('sb')
      .word8('naws')
      .word16bu('width')
      .word16bu('height')
      .word8('iac2')
      .word8('se')
      .tap(function (vars) {
        //console.error(vars)
        assert(vars.iac1 === COMMANDS.IAC);
        assert(vars.iac2 === COMMANDS.IAC);
        assert(vars.sb === COMMANDS.SB);
        assert(vars.se === COMMANDS.SE);
        assert(vars.naws === OPTIONS.WINDOW_SIZE);
        event.cols = event.columns = event.width = vars.width;
        event.rows = event.height = vars.height;
      });
  }
  return event;
};


var MORE = -123132;

function parse(bufs) {
  assert(bufs.length >= 2); // IAC byte and whatever follows it
  assert(bufs.get(0) === COMMANDS.IAC);
  return parseCommand(bufs, 1, {});
}

function parseCommand (bufs, i, event) {
  var command = bufs.get(i);
  event.commandCode = command;
  event.command = COMMAND_NAMES[command];
  return COMMAND_IMPLS[command](bufs, i + 1, event);
}

function parseOption (bufs, i, event) {
  var option = bufs.get(i);
  event.optionCode = option;
  event.option = OPTION_NAMES[option];
  return OPTION_IMPLS[option](bufs, i + 1, event);
}

/**
 * OptionSet manages the state of all options, on either local or remote side.
 * The behavior follows RFC 1143 (The Q Method of Implementing TELNET Option
 * Negotiation)
 * @param socket: The Socket these options are managed on.
 * @param serverOpts: true if these options are for the server (local) side.
 * false if they are for the client (remote) side.
 * @constructor
 * @see {@link https://tools.ietf.org/html/rfc1143|RFC 1143}
 */

function OptionSet (socket, serverOpts) {
  var self = this;

  this._socket = socket;

  // RFC 1143, Section 7:
  // "...We handle the option on our side by the same procedures, with DO-
  // WILL, DONT-WONT, him-us, himq-usq swapped."
  // (In our implementation, him-us and himq-usq are 'swapped' by
  // being stored in separate OptionSets)

  // commands to send (as request or acknowledgement)
  this._sendEnable = serverOpts ? COMMANDS.WILL : COMMANDS.DO;
  this._sendDisable = serverOpts ? COMMANDS.WONT : COMMANDS.DONT;
  // commands to receive (as request or acknowledgement)
  this._receiveEnable = serverOpts ? COMMANDS.DO : COMMANDS.WILL;
  this._receiveDisable = serverOpts ? COMMANDS.DONT : COMMANDS.WONT;

  socket.on('event', function () {
    self._handleOptions.apply(self, arguments);
  });
}

OptionSet.prototype._handleOptions = function(event) {
  // TODO: Hide option events - not sure how yet.
  // TODO: Handle only option events.
  if (event.option) {

    // TODO: Implement option handling.

    // This is the default - reject all options.
    switch(event.commandCode){
      case this._receiveDisable:
        // RFC 1143, Section 7:
        // "Upon receipt of WONT, we choose based upon him and himq:
        //      NO            Ignore.
        // ..."
        break;
      case this._receiveEnable:
        // RFC 1143, Section 7:
        // "Upon receipt of WILL, we choose based upon him and himq:
        //      NO            If we agree that he should enable, him=YES, send
        //                    DO; otherwise, send DONT.
        // ..."
        debug("declining '" + COMMAND_NAMES[this._receiveEnable] + " " + event.option + "' - no option handler registered.");
        this._socket.output.write(new Buffer([COMMANDS.IAC, this._sendDisable, event.optionCode]));
        break;
    }
  }
};


/**
 * Socket handles each client/server connection.
 */

function Socket (input, output) {
  // TODO: Move to new Node Streams?
  var bufs = Buffers(),
      self = this,
      data;

  Stream.call(this);

  this.bufs = bufs;
  this.input = input;
  this.output = output;
  this.convertLF = true;
  this.options = {
    local: new OptionSet(this, true),
    remote: new OptionSet(this, false)
  };
  // We pause input until someone listens for our 'data' event.
  // In addition to mimicking how Stream.Readable acts, this also
  // lets option handlers be set correctly before we start responding
  // to option requests.
  // TODO: Ensure our semantics match Stream.Readable re: explicit pausing.
  this.input.pause();
  this.on('newListener', function(event) {
    if (event === 'data') {
      self.input.resume();
    }
  });

  // proxy "close", "end", "error"
  this.input.on('end', function () {
    self.emit('end');
  });
  this.input.on('close', function () {
    self.emit('close');
  });
  this.input.on('drain', function () {
    self.emit('drain');
  });
  this.input.on('error', function (e) {
    self.emit('error', e);
  });

  // this main 'data' listener
  this.input.on('data', function (b) {
    var i;

    debug('incoming "data" event %j', b.toString('utf8'), b);
    bufs.push(b);

    while ((i = bufs.indexOf(IAC_BUF)) >= 0) {
      assert(bufs.length > (i + 1));
      if (i > 0) {
        data = bufs.splice(0, i).toBuffer();
        self.emit('data', data);
      }
      i = parse(bufs);
      if (i === MORE) {
        debug('need to wait for more...');
        break;
      } else {
        debug('emitting event', i);
        // TODO: Remove event emits for events handled by OptionSet.
        self.emit('event', i);
        self.emit(i.command, i);
        if (i.option) {
          self.emit(i.option, i);
        }
        if (i.data) {
          self.emit('data', i.data);
        }
      }
    }
    if (i !== MORE && bufs.length > 0) {
      // we got regular data!
      data = bufs.splice(0).toBuffer();
      self.emit('data', data);
    }
  });
}
require('util').inherits(Socket, Stream);
exports.Socket = Socket;

// readable stuff
Object.defineProperty(Socket.prototype, 'readable', {
  get:          function () {
    return this.input.readable;
  },
  set:          function (v) {
    this.input.readable = v;
    return v;
  },
  enumerable:   true,
  configurable: true
});
Socket.prototype.pause = function () {
  return this.input.pause.apply(this.output, arguments);
};
Socket.prototype.resume = function () {
  return this.input.resume.apply(this.output, arguments);
};

// writable stuff
Object.defineProperty(Socket.prototype, 'writable', {
  get:          function () {
    return this.output.writable;
  },
  set:          function (v) {
    this.output.writable = v;
    return v;
  },
  enumerable:   true,
  configurable: true
});
Socket.prototype.write = function (b) {
  if (this.convertLF) {
    b = b.toString('utf8').replace(/\r?\n/g, '\r\n');
  }
  // TODO: Prevent writing of IAC? escape it/error as appropriate?
  debug('writing outgoing data %j', b);
  return this.output.write.apply(this.output, arguments);
};
Socket.prototype.end = function () {
  return this.output.end.apply(this.output, arguments);
};
Socket.prototype.destroy = function () {
  return this.output.destroy.apply(this.output, arguments);
};
Socket.prototype.destroySoon = function () {
  return this.output.destroySoon.apply(this.output, arguments);
};



/**
 * Sends out a telnet command.
 */

function Command (command, client) {
  this.command = COMMANDS[command.toUpperCase()];
  this.client = client;
  if (debug.enabled) {
    this.commandName = command;
  }
}

Object.keys(OPTIONS).forEach(function (name) {
  var code = OPTIONS[name];
  Command.prototype[name.toLowerCase()] = function () {
    var buf = Buffer(3);
    buf[0] = COMMANDS.IAC;
    buf[1] = this.command;
    buf[2] = code;
    debug('writing Command', this.commandName, name, buf);
    return this.client.output.write(buf);
  };
});


/**
 * Convenience function to create a Telnet TCP/IP server.
 * Listen for the "client" event.
 */

function telnet (cb) {
  var net    = require('net'),
      server = net.createServer(conn);

  function conn (socket) {
    var client = new Socket(socket, socket);
    server.emit('client', client);
  }
  if (typeof cb === 'function') {
    server.on('client', cb);
  }
  return server;
}

// if you're more old skool (like the net.createServer() syntax)...
exports.createServer = telnet;
