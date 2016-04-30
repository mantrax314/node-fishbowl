/// <reference path="../typings/tsd.d.ts"/>

//Testing modules
import chai = require('chai');
var should = chai.should();
import sinon = require('sinon');
import bunyan = require('bunyan');

//Server modules
import net = require('net');

//Fishbowl Library
import Fishbowl from './fishbowl'

function createFbInstance() {
  //This is just to create a new FB instance and override logger to /dev/null
  var fb = new Fishbowl();
  fb.log = bunyan.createLogger({
    name: 'fishbowl-lib',
    streams: [{
      path: '/dev/null'
    }]
  });

  return fb;
}

describe('Fishbowl Library', ()=> {
  var fb: Fishbowl;

  describe('Constructor', ()=> {
    fb = new Fishbowl();

    it('should set the correct self values', ()=> {
      fb.username.should.be.a('string');
      fb.password.should.be.a('string');
      fb.host.should.be.a('string');
      fb.port.should.be.a('number');
      fb.token.should.equal('');
      fb.userId.should.equal('');
      fb.isConnected.should.equal(false);
      fb.isWaiting.should.equal(false);
      fb.reqQueue.should.be.an('array').and.empty;
      fb.log.should.be.an('object');
    });
  });

  describe('Private Functions', ()=> {
    beforeEach(() => {
      fb = createFbInstance();
    });

    describe('checkQueue', ()=> {
      it('should set isWaiting to false', ()=> {
        fb.isWaiting = true;
        fb.checkQueue();
        fb.isWaiting.should.equal(false);
      });
      it('should call sendRequest if there are calls in the reqQueue', ()=> {
        let stub = sinon.stub(fb, 'sendRequest');
        fb.reqQueue = [{
          json: 'testJson1',
          cb: 'callbackFunction1'
        }, {
          json: 'testJson2',
          cb: 'callbackFunction2'
        }];
        fb.checkQueue();
        fb.reqQueue.length.should.equal(1);
        stub.args[0][0].should.equal('testJson1');
        stub.args[0][1].should.equal('callbackFunction1');
      });
      it('should not call sendRequest if the queue is empty', ()=> {
        let stub = sinon.stub(fb, 'sendRequest');
        fb.checkQueue();
        fb.reqQueue.length.should.equal(0);
        stub.called.should.equal(false);
      });
    });

    describe('doLogin', ()=> {
      it('should send a valid object to the login server', ()=> {
        let stub = sinon.stub(fb, 'sendRequest');
        fb.doLogin();
        stub.args[0][0].action.should.equal('LoginRq');
        stub.args[0][0].params.IAID.should.be.a('number');
        stub.args[0][0].params.IAName.should.be.a('string');
        stub.args[0][0].params.IADescription.should.be.a('string');
        stub.args[0][0].params.UserName.should.be.a('string');
        stub.args[0][0].params.UserPassword.should.be.a('string');
      });
    });

    describe('errorCheckandFormat', ()=> {
      it('should pass an error on that is already set', ()=> {
        let spy = sinon.spy();
        fb.errorCheckandFormat('This was a bad error.', null, spy);
        spy.args[0][0].should.equal('This was a bad error.');
        should.not.exist(spy.args[0][1]);
      });
      it('should find the correct error in general request', ()=> {
        let spy = sinon.spy();
        fb.errorCheckandFormat(undefined, {
          FbiXml: {
            FbiMsgsRs: {
              statusCode: '1001',
              statusMessage: 'There was an error.'
            }
          }
        }, spy);
        spy.args[0][0].should.equal('1001 - Unknown message received. There was an error.');
        should.not.exist(spy.args[0][1]);
      });
      it('should find the correct error for specific request', ()=> {
        let spy = sinon.spy();
        fb.errorCheckandFormat(undefined, {
          FbiXml: {
            FbiMsgsRs: {
              statusCode: '1000',
              ExecuteQueryRs: {
                statusCode: '1002',
                statusMessage: 'There was an error.'
              }
            },
          }
        }, spy);
        spy.args[0][0].should.equal('1002 - Connection to Fishbowl server was lost. There was an error.');
        should.not.exist(spy.args[0][1]);
      });
      it('should pass data to login with no error and LoginRs', ()=> {
        let spy = sinon.spy();
        let loginXml = {
          FbiXml: {
            Ticket: {
              Key: 'abc123',
              UserID: '999'
            },
            FbiMsgsRs: {
              statusCode: '1000',
              LoginRs: {
                statusCode: '1000'
              }
            }
          }
        };

        fb.errorCheckandFormat(undefined, loginXml, spy);
        should.not.exist(spy.args[0][0]);
        spy.args[0][1].should.deep.equal(loginXml);
      });
      it('should pass data to notCSVtoJson with no error and CSV response', ()=> {
        let spy = sinon.spy();
        let notCSVtoJsonStub = sinon.stub(fb, 'notCSVtoJson');
        let sqlXml = {
          FbiXml: {
            Ticket: {
              Key: 'abc123',
              UserID: '999'
            },
            FbiMsgsRs: {
              statusCode: '1000',
              ExecuteQueryRs: {
                statusCode: '1000',
                Rows: {
                  Row: ['Head1,Head2', 'Val1,Val2']
                }
              }
            }
          }
        };

        fb.errorCheckandFormat(undefined, sqlXml, spy);
        spy.called.should.equal(false);
        notCSVtoJsonStub.args[0][0].should.deep.equal(sqlXml.FbiXml.FbiMsgsRs.ExecuteQueryRs);
        notCSVtoJsonStub.args[0][1].should.equal(spy);
      });
      it('should pass data to callback with no error', ()=> {
        let spy = sinon.spy();
        let otherXml = {
          FbiXml: {
            Ticket: {
              Key: 'abc123',
              UserID: '999'
            },
            FbiMsgsRs: {
              statusCode: '1000',
              CustomerSaveRs: {
                statusCode: '1000'
              }
            }
          }
        };

        fb.errorCheckandFormat(undefined, otherXml, spy);
        should.not.exist(spy.args[0][0]);
        spy.args[0][1].should.deep.equal(otherXml.FbiXml.FbiMsgsRs.CustomerSaveRs);
      });
    });

    describe('findError', ()=> {
      it('should return a message when a non-error is passed (1000)', ()=> {
        fb.findError('1000').should.equal('A code of 1000 (no error) was passed to findError');
      });
      it('should find the correct error message when given an code', ()=> {
        fb.findError('7000').should.equal('7000 - Pricing Rule error.');
      });
      it('should return a message when a unknown error code is given', ()=> {
        fb.findError('12345678').should.equal('12345678 - This is not in the error database.');
      });
    });

    describe('hashPassword', ()=> {
      it('should return a base64 representation of a md5 hash of a string', ()=> {
        fb.hashPassword('testpassword').should.equal('4WsquNEjFL9O+9YgOQbqbA==');
      });
    });

    describe('json2fbXml', ()=> {
      it('should create a valid xml document with token from API request', ()=> {
        fb.token = "testToken";
        fb.json2fbXml({
          action: 'fbRequest',
          params: {
            userId: '22'
          }
        }).should.equal('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE FbiXml><FbiXml><Ticket><Key>testToken</Key></Ticket><FbiMsgsRq><fbRequest><userId>22</userId></fbRequest></FbiMsgsRq></FbiXml>');
      });
      it('should create a valid xml document without token from API request', ()=> {
        fb.token = undefined;
        fb.json2fbXml({
          action: 'fbRequest',
          params: {
            userId: '232'
          }
        }).should.equal('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE FbiXml><FbiXml><Ticket><Key></Key></Ticket><FbiMsgsRq><fbRequest><userId>232</userId></fbRequest></FbiMsgsRq></FbiXml>');
      });
    });

    describe('jsonTFunction', ()=> {
      it('should transverse and array', ()=> {
        fb.jsonTFunction({
          testArray: [{
            testSub1: 'sub1'
          }, {
            testSub2: 'sub2'
          }]
        }).should.deep.equal({
          testArray: [{
            testSub1: {
              '$t': 'sub1'
            }
          }, {
            testSub2: {
              '$t': 'sub2'
            }
          }]
        });
      });
      it('should transverse an object', ()=> {
        fb.jsonTFunction({
          testKey2: {
            testKey3: 'testVal3'
          }
        }).should.deep.equal({
          testKey2: {
            testKey3: {
              '$t': 'testVal3'
            }
          }
        });
      });
      it('should return a $t value for any other value', ()=> {
        fb.jsonTFunction({
          testKey: 'testVal'
        }).should.deep.equal({
          testKey: {
            '$t': 'testVal'
          }
        });
      });
    });

    describe('notCSVtoJson', ()=> {
      it('should exclude rows that are empty', (done)=> {
        fb.notCSVtoJson({
          Rows: {
            Row: [
              'HEAD1,HEAD2',
              {},
              'VAL1,VAL2'
            ]
          }
        }, (err, json) => {
          should.not.exist(err);
          json.should.deep.equal([{
            'HEAD1': 'VAL1',
            'HEAD2': 'VAL2'
          }]);
          done();
        });
      });
      it('should return an error on csv library error', (done)=> {
        fb.notCSVtoJson({
          Rows: {
            Row: [
              'HEAD",HE,,AD',
              'THIS,SHOULD,ERR'
            ]
          }
        }, (err, json) => {
          should.not.exist(json);
          err.should.be.an('error');
          done();
        });
      });
      it('should return a json object to the callback on success', (done)=> {
        fb.notCSVtoJson({
          Rows: {
            Row: [
              'HEAD1,HEAD2',
              'VAL1,VAL2',
              'VAL3,VAL4'
            ]
          }
        }, (err, json)=> {
          should.not.exist(err);
          json.should.deep.equal([{
            'HEAD1': 'VAL1',
            'HEAD2': 'VAL2'
          }, {
            'HEAD1': 'VAL3',
            'HEAD2': 'VAL4'
          }]);
          done();
        });
      });
    });

    describe('sendRequest', ()=> {
      it('should push the request to the call queue if currently busy', ()=> {
        fb.reqQueue.length.should.equal(0);
        fb.isWaiting = true;
        fb.sendRequest({
          params: {},
          action: 'Sql Request'
        }, ()=> {});

        fb.reqQueue.length.should.equal(1);
      });
      it('should call setupConnection if not connected and push call to queue', ()=> {
        let stub = sinon.stub(fb, 'setupConnection');
        fb.reqQueue.length.should.equal(0);
        fb.isWaiting = false;
        fb.sendRequest({
          params: {},
          action: 'SqlReq'
        }, ()=> {});

        fb.reqQueue.length.should.equal(1);
        fb.isWaiting.should.equal(true);
        stub.called.should.equal(true);
      });
      it('should send the correct data to the fishbowl server', (done)=> {
        //This specs a login function.  Any other function calls a login
        //before itself and the login uses the same sending function.

        //Set up echo server
        let server = net.createServer((conn)=> {
          conn.on('data', (d)=> {
            let resLength = d.readInt32BE(0);
            let resData = d.slice(4).toString();
            resLength.should.equal(292);
            resData.should.equal('<?xml version="1.0" encoding="UTF-8"?>' +
            '<!DOCTYPE FbiXml><FbiXml><Ticket><Key></Key></Ticket>' +
            '<FbiMsgsRq><LoginRq><IAID>2222</IAID><IAName>Test Suite</IAName>' +
            '<IADescription>Test suite App</IADescription><UserName>admin' +
            '</UserName><UserPassword>admin2</UserPassword></LoginRq></FbiMsgsRq>' +
            '</FbiXml>');
            done();
          });
        });
        server.listen(9999);

        fb.host = '127.0.0.1';
        fb.port = 9999;
        fb.IAID = 2222;
        fb.IAName = 'Test Suite';
        fb.IADescription = 'Test suite App';
        fb.username = 'admin';
        fb.password = 'admin2';

        fb.sendRequest({
          params: {},
          action: 'AnyAction'
        }, ()=> {});
      });
    });

    describe('setupConnection', ()=> {

    });

    describe('setUser', ()=> {
      it('should set the user token and userId', ()=> {
        fb.token.should.equal('');
        fb.userId.should.equal('');
        fb.setUser(undefined, {
          FbiXml: {
            Ticket: {
              Key: 'newKey',
              UserID: '66'
            },
            FbiMsgsRs: {
              statusCode: '1000'
            }
          }
        });
        fb.token.should.equal('newKey');
        fb.userId.should.equal('66');
      });
      it('should log an error on error', ()=> {
        let stub = sinon.stub(fb.log, 'error');
        fb.token.should.equal('');
        fb.userId.should.equal('');
        fb.setUser('oops', undefined);
        fb.token.should.equal('');
        fb.userId.should.equal('');
        stub.called.should.equal(true);
      });
    });

    describe('xmlSanitize', ()=> {
      it('should remove/replace &', ()=> {
        fb.xmlSanitize('Test&String').should.equal('Test&amp;String');
      });
      it('should remove/replace <', ()=> {
        fb.xmlSanitize('Test<String').should.equal('Test&lt;String');
      });
      it('should remove/replace >', ()=> {
        fb.xmlSanitize('Test>String').should.equal('Test&gt;String');
      });
      it('should replace multiple instances of a string', ()=> {
        fb.xmlSanitize('Test&Strin&').should.equal('Test&amp;Strin&amp;'); 
      })
    });

  });


});
