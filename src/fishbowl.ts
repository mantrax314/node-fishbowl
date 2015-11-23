/// <reference path="../typings/tsd.d.ts" />
/// <reference path="./d.ts/fishbowl.d.ts" />

//Load Native Modules
import crypto = require('crypto');
import path = require('path');
import net = require('net');

//Load third party modules
import bunyan = require('bunyan');
import _ = require('lodash');
var xmlParser = require('xml2json');
var csv = require('csv');

//Load error codes
var errList = require('../lib/resCodes.json');



export class Fishbowl {
  /**
  * Username to login to Fishbowl
  */
  username: string;
  /**
  * Password to login to Fishbowl
  */
  password: string;
  /**
  * Host Fishbowl is running on
  */
  host: string;
  /**
  * Port Fishbowl is running on
  */
  port: number;
  /**
  * Integrated Application ID Number to use
  */
  IAID: number;
  /**
  * Integrated Application Name to use
  */
  IAName: string;
  /**
  * Integrated Application Description to use
  */
  IADescription: string;
  /**
  * Logging level for bunyan Logger
  */
  bunyanLevel: string;
  token: string = '';
  userId: string = '';
  //conn: net.Socket;  //The next line is any as the current node typings are missing
  //listenerCount. When they typings are correct, this can be changed to net.Socket
  conn: any;
  isConnected: boolean = false;
  isWaiting: boolean = false;
  reqQueue: any[] = [];
  log: bunyan.Logger;

  constructor(opts?) {
    opts = _.defaults(opts || {}, {
      host: '127.0.0.1',
      IADescription: 'A node wrapper for Fishbowl Inventory',
      IAID: 2286,
      IAName: 'node-fishbowl',
      password: 'admin2',
      port: 28192,
      username: 'admin',
      bunyanLevel: 'debug'
    });

    this.host = opts.host;
    this.IADescription = opts.IADescription;
    this.IAID = opts.IAID;
    this.IAName = opts.IAName;
    this.password = this.hashPassword(opts.password);
    this.port = opts.port;
    this.username = opts.username;

    this.log = bunyan.createLogger({
      name: this.IAName,
      streams: [{
        stream: process.stdout,
        level: opts.bunyanLevel
      }]
    });
  }

  /**
  Checks the internal request queue to see if we have any pending requests.
  This was done without any metering before... Disaster.
  @private
  @return {void} Calls the next request in the queue
  */
  checkQueue(): void {
    this.isWaiting = false;

    if (this.reqQueue.length > 0) {
      //If there are more requests to process, send the next one.
      var nextReq = this.reqQueue.shift();
      this.sendRequest(nextReq.json, nextReq.cb);
    }
  }

  /**
  This logins in the user and grabs the login token to be sent with all subsequent
  requests.
  @private
  @return {void} Calls pending request
  */
  doLogin(): void{
    var loginJson = {
      action: 'LoginRq',
      params: {
        IAID: this.IAID,
        IAName: this.IAName,
        IADescription: this.IADescription,
        UserName: this.username,
        UserPassword: this.password
      }
    };

    this.sendRequest(loginJson, (err, json)=> {
      this.setUser(err, json);
    });
  }

  /**
  Takes the parsed JSON response from the Fishbowl server and checks if
  there are any errors.  Then it approprately sends the request to the next
  handler, if needed, or to the call back.
  @private
  @param {err} err Error from a earlier step in the response process.
  @param {object} data JSON parsed XML from Fishbowl response
  @param {function} cb Callback function for when request is done.  Generally
                       this is the res for restify.
  @return {void} Calls callback in params.
  */
  errorCheckandFormat(err: string, data: fbApiResponse, cb:(err: string, data: fbApiResponse)=> void): void {
    if (err) {
      //If this error is set, we just need to pass it on.
      return cb(err, null);
    }
    /**
    There are two status messages sent back by the Fishbowl server.  One
    located under FbiXml>FbiMsgsRs>statusCode and a second under
    FbiXml>FbiMsgsRs>[action]>statusCode.  This function looks at both of them
    and does the final processing of the object before sending back to the
    callback function.
    */
    if (data.FbiXml.FbiMsgsRs.statusCode !== '1000') {
      let newErr = this.findError(data.FbiXml.FbiMsgsRs.statusCode) + ' ' + data.FbiXml.FbiMsgsRs.statusMessage;
      this.log.error(newErr);
      return cb(newErr, null);
    }

    //Since the second error message lives in a dynamic property, I just delete the status code and the
    //only other property is the one we're after.
    delete data.FbiXml.FbiMsgsRs.statusCode;
    var unknownChild = Object.keys(data.FbiXml.FbiMsgsRs)[0];
    if (data.FbiXml.FbiMsgsRs[unknownChild].statusCode !== '1000') {
      let newErr = this.findError(data.FbiXml.FbiMsgsRs[unknownChild].statusCode) + ' ' + data.FbiXml.FbiMsgsRs[unknownChild].statusMessage;
      this.log.error(newErr);
      return cb(newErr, null);
    }

    // By here we should have caught all errors. Delete the status code so that the
    //unknown child only holds the data we want to return.
    delete data.FbiXml.FbiMsgsRs[unknownChild].statusCode;

    //Different returns for different types of queries.
    if (unknownChild === 'LoginRs') {
      //Then a login was made.  Generally the login token gets stripped out.
      //This allows the token to be passed back to be set internally.
      return cb(null, data);
    } else if (unknownChild === 'ExecuteQueryRs') {
      //It was an SQL query and we need to parse it correctly.
      this.notCSVtoJson(data.FbiXml.FbiMsgsRs[unknownChild], cb);
    } else {
      //Regular Request. Return Data
      return cb(null, data.FbiXml.FbiMsgsRs[unknownChild]);
    }
  }

  /**
  Takes an error code and returns the error message from the
  Fishbowl error list.
  @private
  @param {string} code The error code to find.
  @return {string} Error number and message
  */
  findError(code: string): string {
    if (code === '1000') {
      return 'A code of 1000 (no error) was passed to findError';
    } else if (errList.hasOwnProperty(code)) {
      return `${code} - ${errList[code]}`;
    } else {
      return `${code} - This is not in the error database.`;
    }
  }

  /**
  * Generates a base64 representation of a md5 hash of a string
  * @private
  * @param {string} plainText The password to encode
  * @returns {string} The encoded password
  */
  hashPassword(plainText: string): string {
    return crypto.createHash('md5')
             .update(plainText)
             .digest('base64');
  }

  /**
  Takes the request object and breaks it apart and adds Fishbowl header
  before sending it to the xmlParser
  @private
  @param {object} json JSON request object.
  @return XML string
  */
  json2fbXml(json: fbApiCall): string {
    var reqObject = {};
    reqObject[json.action] = this.jsonTFunction(json.params);

    //Then return request with header
    return '<?xml version="1.0" encoding="UTF-8"?>' +
           '<!DOCTYPE FbiXml>' +
      xmlParser.toXml({
        "FbiXml": {
          "Ticket": {
            "Key": {
              $t: (this.token || '')
            }
          },
          "FbiMsgsRq": reqObject
        }
      });
  }

  /**
  Takes an object and returns an object that will be parsed correctly by the
  XML parsing library.
  @private
  @param {object} obj The object to transform
  @return Processed object
  */
  jsonTFunction(obj: any): any {
    return _.mapValues(obj, (cV) => {
      if (Array.isArray(cV) === true) {
        return _.map(cV, (cV2)=> {
          return this.jsonTFunction(cV2);
        });
      } else if (typeof cV === 'object') {
        return this.jsonTFunction(cV);
      } else {
        return {
          '$t': this.xmlSanitize(cV)
        };
      }
    });
  }

  /**
  Returns the Fishbowl equivalent of CSV to a standard JSON array
  Fishbowl says that they return their SQL queries back as a CSV.  They don't.
  YOLO
  @private
  @param {object} notCSV The malformed row by row CSV
  @param {function} cb The callback function with CSV->JSON object when done
  @return Executes callback function with results.
  */
  notCSVtoJson(notCSV: fbCsvResponse, cb: (err: string, JsonFromCsv: any)=> void) {
    //If there is not an array, there were no results. Really, I think, this
    //should be changed as there should always be one row with the
    //column headers... TBD
    var csvString = '';

    _.each(notCSV.Rows.Row, (cV)=> {
      //There's a weird parsing error where a <Row /> gets changed to an
      //empty Object.  This is my fix for that.
      if (typeof cV === 'object') {
        return;
      }
       csvString = csvString + cV + '\n';
    });

    var retObject = csv.parse(csvString, { columns: true }, (err, pObj)=> {
      if (err) {
        return cb(err, null);
      }

      return cb(null, pObj);
    });
  }

  /**
  Sends the request to the Fishbowl Server
  @param {object} requestJson XML request as a JSON object
  @param {function} cb Callback function containing results of request
  @return {function} Calls the callback with response.
  */
  sendRequest(requestJson: fbApiCall, cb: (err: string, json: fbApiResponse)=> void): void {
    //If it's not a login and we're trying to work then catch it.
    if ((this.isWaiting === true) && (requestJson.action !== 'LoginRq')) {
      this.reqQueue.push({
        json: requestJson,
        cb: cb
      });
      return;
    }

    //Set waiting to true so we don't overload the request/response pipes
    this.isWaiting = true;

    //If we're connected, go go go!
    if (this.isConnected === true) {
      //Set up one time listener for 'done'. 'done' is emitted when a complete
      //message is recieved from the Fishbowl server
      this.conn.once('done', (err, data: fbApiResponse)=> {
        this.errorCheckandFormat(err, data, cb);
        //If we're logging in, don't send the next request until we add our ticket.
        if (typeof data.FbiXml.FbiMsgsRs.LoginRs === 'undefined') {
          this.checkQueue();
        }
      });

      //Build request
      let xml = this.json2fbXml(requestJson);
      let reqLength = new Buffer(4);
      reqLength.writeIntBE(xml.length, 0, 4);

      this.log.debug('Sending Request to Fishbowl Server: ', xml, reqLength.readInt32BE(0));
      this.conn.write(reqLength);
      this.conn.write(xml);
    } else {
      //If we're not logged in, Queue the request and login first.
      this.log.debug('Client not connected to Server...');
      this.reqQueue.push({
        json: requestJson,
        cb: cb
      });
      this.setupConnection();
      return;
    }
  }

  /**
  Sets up a connection to the Fishbowl server and initiates the login.
  This also sets up the listeners for the conenction.
  @private
  @return {function} Calls login and then any request queued
  */
  setupConnection() {
    var resLength,                          //Expected Length of return data
    resData;                                //Total data returned from server

    this.conn = new net.Socket();

    this.conn.connect(this.port, this.host, ()=> {
      this.log.debug('Connected to Fishbowl Server. Logging in...');
      this.isConnected = true;
      this.doLogin();
    });

    //Listeners for the connection.
    this.conn.on('close', ()=> {
      this.log.info('The connection to the Fishbowl server was terminated.');
      this.isConnected = false;
    });

    this.conn.on('error', (e)=> {
      //If there's a done listener, then we're coming from trying to get something
      //from the Fishbowl server.  No need crashing everything if I don't need to.
      //listenerCount is fine. It is included on the EventEmitter in the node.d.ts
      //file.  For some reason it inherits the methods but not the static property.
      this.conn.listeners
      if (this.conn.listenerCount('done') > 0) {
        this.log.error(e);
        this.conn.emit('done', e, null);
      } else {
        throw new Error(e);
      }
    });

    this.conn.on('data', (d)=> {
      this.log.debug('Data from Fishbowl server received...');
      if (resLength === undefined) {
        resLength = d.readInt32BE(0);     //Read resLength from Fishbowl
        resData = d.slice(4);             //Set everything after to be the first
                                          //data chuck from server
      } else {
        resData = Buffer.concat([resData, d]);
      }
      //If the data we have matches the length of response, process.
      if (resData.length === resLength) {
        this.log.debug('Response from Fishbowl server: ', resData.toString('utf8'));
        //Parse from XML to JSON and parse
        var resJson = xmlParser.toJson(resData.toString('utf8'), {
          sanitize: false,
          object: true
        });
        resLength = undefined;                    //Reset length to get ready for next response

        //Sometimes the server will disconnect us for inactivity.  We need to
        //make sure we know the server doesn't love us anymore.
        if (resJson.FbiXml.FbiMsgsRs.statusCode === '1010') {
          this.log.info('Disconnect notice recieved from server.');
          this.isConnected = false;
        } else {
          this.conn.emit('done', null, resJson);  //Move on.
        }
      } else {
        this.log.debug("Waiting for more data from Fishbowl Server...");
      }
    });
  }

  /**
  Sets the user token and userID
  @private
  @param {string} err An error from upstream.
  @param {object} json The object carrying the login response details
  @return {void}
  */
  setUser(err: string, json: fbApiResponse): void {
    //If error
    if (err) {
      this.log.error(`There was a problem logging in. ${err}`);
    } else {
      this.token = json.FbiXml.Ticket.Key;      //Login token given by fishbowl server
      this.userId = json.FbiXml.Ticket.UserID;  //User ID returned by fishbowl server
      this.checkQueue();
    }
  }

  /**
  Returns a sanitized XML string
  @private
  @param {string} xmlString XML string to process
  @return {string} Returns sanitized XML string
  */
  xmlSanitize(xmlString: string): string {

    var saniReg = /[&<>]/; //The chars we are checking for
    if (saniReg.test(xmlString) === true) {
      var saniMap = [{
        search: '&',            //If '&' isn't first, you're going to have a bad time
        sanitized: '&amp;'
      }, {
        search: '<',
        sanitized: '&lt;'
      }, {
        search: '>',
        sanitized: '&gt;'
      }];

      saniMap.forEach((cV)=> {
        xmlString = xmlString.replace(cV.search, cV.sanitized);
      });
    }

    return xmlString;
  }



}

