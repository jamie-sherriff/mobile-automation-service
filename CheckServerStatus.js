/*jslint node: true*/
'use strict';
/**
 * Created by jamie on 12/08/15.
 */

var request = require('request'),
	processConfiguration = require('./helpers/process-configuration'),
	timeoutCount = 0;
var os = require('os');
let timeoutLimit;

if(os.hostname() === 'mobileqa'){
	timeoutLimit = 240;
} else {
	timeoutLimit = 75;
}


var configOptions = processConfiguration.configOptions;
function checkServerStatus() {
	var url = configOptions.deviceServerUrl + 'internal/status';
	var options = {
		url: url,
		timeout: 30000
	};
	request(options, function (error, response, body) {
		if (!error && response.statusCode === 200) {
			console.log(body);
			var jsonResponse = JSON.parse(body);
			if (jsonResponse.time && jsonResponse.status === 'running') {
				console.log('Found device server running so exit 0');
				process.exit(0);
			}
			else {
				console.error('something went wrong checking device server response so quitting');
				process.exit(1);
			}

		}
		else {
			if (error) {
				timeoutCount += 1;
				if (timeoutCount > timeoutLimit) {
					console.error('giving up at polling: ' + url + ' with error: ');
					console.error(error);
					process.exit(1);
				}
				setTimeout(function () {
					console.log(url + ' not up so trying again');
					checkServerStatus();
				}, 500);
			} else {
				console.error('should not be in this state for device server so exiting');
				console.error(error);
				console.error(response);
				console.error(body);
				process.exit(1);
			}
		}
	});
}
checkServerStatus();