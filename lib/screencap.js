/**
 * Created by jamie on 26/04/17.
 */
'use strict';
let sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const when = require('when');
const whenNode = require('when/node');
const _ = require('lodash');
// const moment = require('moment'); TODO add a time based timeout
const debug = require('debug')('automation:device-server:screencap');
const debugTrace = require('debug')('automation-trace:device-server:screencap');
const fsPromise = whenNode.liftAll(require('fs-extra'));
const WebSocket = require('ws');
const WebSocketServer = require('ws').Server;
const adb = require('adbkit');
const RunningConfigObjects = require('./running');
const moment = require('moment');
sharp.cache(false);

function shellCommandWithOutput(deviceSerial, adbClient, command, timeoutMs = 30000, logOutput = false) {
	debugTrace('running shellCommandWithOutput for : ' + command);
	return adbClient
		.shell(deviceSerial, command)
		.then(adb.util.readAll)
		.then((output) => {
			let stringOutput = output.toString().trim();
			if (logOutput) {
				console.log('shellCommandWithOutput for:' + command + ' output: ' + stringOutput);
			}
			return stringOutput;
		}).timeout(timeoutMs, 'shellCommandWithOutput doing: ' + command);
}


//Bash equiv adb shell dumpsys input | grep 'SurfaceOrientation' | awk '{ print $2 }'
function getRotationFromInput(inputDump) {
	try {
		//eslint-disable-next-line no-control-regex, no-useless-escape
		const rotationInt = _.toInteger(inputDump.match(new RegExp('SurfaceOrientation:([^\s]*\r\n)'))[0].split(':')[1].replace('\r\n', ''));
		debugTrace('rotationInt is: ' + rotationInt);
		switch (rotationInt) {
			//TODO figure out what normal is relative to others as this varies emulator/devices/manufactures etc
			case 0:
			case 2:
				return 0;
			case 1:
			case 3:
				return 270;
			default:
				return 0;
		}
	} catch (error) { //Catch output changes for newer android versions untill framework is updated.
		debug('Error in getRotationFromInput: ' + error);
		debug('Defaulting to 0...');
		return 0;
	}

}

function takeScreenCap(adbClient, deviceSerial, outputDir) {
	//let rotation = null;
	const dumpInputCmd = 'dumpsys input';
	return shellCommandWithOutput(deviceSerial, adbClient, dumpInputCmd)
		.then((inputDumpOutput) => {
			let rotation = getRotationFromInput(inputDumpOutput);
			return when.promise((resolve, reject) => {
				let options = {quality: 80, force: true};
				let jpgCompressor =
					sharp()
						.rotate(rotation)
						.jpeg(options)
						.on('error', function (err) {
							console.error(err);
						})
						.on('info', function (info) {
							debugTrace('Received image is:' + JSON.stringify(info));
						});
				return adbClient
					.screencap(deviceSerial)
					.then((pngStream) => {
						debugTrace('Saving capture: ' + outputDir);
						let wstream = fs.createWriteStream(outputDir);
						pngStream.pipe(jpgCompressor).pipe(wstream);
						wstream.on('error', reject);
						pngStream.on('error', reject);
						wstream.on('finish', () => {
							debugTrace('wstream finished');
							resolve(outputDir);
						});

					});
			});
		});

}

module.exports.startScreencapSocket = function (adbClient, deviceSerial, configOptions) {
	let savedFrameCount = 1;
	let wss = new WebSocketServer({perMessageDeflate: false, port: 9002});
	wss.on('error', error => {
		console.error('wss screencap server got an error: ' + error);
		return when.reject(new Error('wss screencap server got an error: ' + error));
	});
	wss.on('connection', function (ws) {
		debug('Got a client');
		ws.on('close', function () {
			debug('Lost a client');
		});
	});
	const startTime = moment();
	return fsPromise.ensureDir(path.resolve(configOptions.screenshotDir, deviceSerial))
		.then(() => {
			(function getScreen(frameCount) {
				const imgNum = _.padStart(frameCount, 5, '0');
				const fileName = path.resolve(configOptions.screenshotDir, deviceSerial, imgNum + '.jpg');
				frameCount++;
				const runningConfig = RunningConfigObjects.getDevice(deviceSerial);
				runningConfig.screenshotFrameCount = frameCount;
				return takeScreenCap(adbClient, deviceSerial, fileName)
					.then((fileToRead) => {
						fs.readFile(fileToRead, (err, data) => {
							wss.clients.forEach(function each(client) {
								if (client.readyState === WebSocket.OPEN) {
									client.send(data, {
										binary: true
									});
								}
							});
						});
						//TODO merge screenCaptureTimeoutMins and dontStopScreenCap configOption
						if (runningConfig.takeScreenshots === true || moment().diff(startTime, 'minutes') > configOptions.screenCaptureTimeoutMins || configOptions.dontStopScreenCap) { //3 hours
							if (configOptions.screenCapDelayMs) {
								return when.resolve()
									.delay(configOptions.screenCapDelayMs)
									.then(() => {
										getScreen(frameCount);
									});

							} else {
								getScreen(frameCount);
							}
						} else {
							//add eventEmitter to say when this stops
							debug('Not doing getScreen loop anymore and took: ' + frameCount + ' pictures');
						}
					});
			})(savedFrameCount);

		})
		.then(() => {
			debug('all done');
			return {socketServer: wss, message: 'screenCap Socket server started'};
		});
};

module.exports.closeSocketServer = (socketServer) => {
	return when.promise((resolve, reject) => {
		if (_.isNull(socketServer) || _.isUndefined(socketServer)) {
			reject('SocketServer is not valid: ' + socketServer);
		} else {
			socketServer.close(() => {
				debug('Socket Server closed');
				resolve('Socket Server closed');
			});
		}
	});
};
