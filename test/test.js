var assert = require('assert');
var telnet = require('../');
var net = require('net');
var buffer = require('buffer');

var clientToServer;
var serverToClient;
var server;
var port = 1337;

var NAWS = 31;
var WILL = 251;
var WONT = 252;
var DO = 253;
var DONT = 254;
var IAC = 255;

describe('telnet', function () {
  it('should export a function', function () {
    assert.equal('function', typeof telnet);
  });

  describe('create server', function () {
    beforeEach(function (done) {
      server = telnet.createServer(function (c) {
        serverToClient = c;
        done();
      });
      server.on('listening', function () {
        clientToServer = net.connect({port: port}, function () {
          // we will detect this via above connection to server.
        });
      });
      server.listen(port);
    });

    afterEach(function (done) {
      clientToServer.end(function () {
        clientToServer = null;
        server.close(function () {
          server = null;
          done();
        });
      });
    });

    it('should echo any data sent to it', function (done) {
      var stringToSend = 'test string';

      serverToClient.on('data', function (b) {
        serverToClient.write(b);
      });

      clientToServer.on('data', function (b) {
        b = b.toString('utf8');
        assert.equal(stringToSend, b);
        done();
      });

      clientToServer.write(stringToSend);
    });

    it('should wait to emit data events until someone is listening', function (done) {
      setTimeout(function () {
        serverToClient.on('data', function (b) {
          assert.deepEqual(b, new buffer.Buffer('x'));
          done();
        }, 100);
      });

      clientToServer.write('x');
    });

    it('should reject all options by default', function (done) {
      clientToServer.write(new buffer.Buffer([IAC, DO, NAWS, IAC, WILL, NAWS]));

      clientToServer.on('data', function (b) {
        assert.deepEqual(b, new buffer.Buffer([IAC, WONT, NAWS, IAC, DONT, NAWS]));
        done();
      });

      serverToClient.on('data', function () {
        // begin processing
      });
    });
  });
});
