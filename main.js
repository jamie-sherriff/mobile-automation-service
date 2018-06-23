/*jshint unused:false*/
'use strict';

/**
 * Created by jamie on 8/07/15.
 * Known bugs
 * Posting back a ios device to a non darwin machine will blow up
 *
 * Known limitations:
 * Assumes xcode installations don't change unless the process is killed and re started
 * iOS simulators relay on the deviceName being correct containing iphone or ipad for deviceType
 *
 *
 *
 */
var adb = require('adbkit'),
	testSetup = require('./lib/server-setup'),
	iOS = require('./lib/ios'),
	android = require('./lib/android'),
	logcat = require('adbkit-logcat'),
	bodyParser = require('body-parser'),
	_ = require('lodash'),
//TODO could move to synchronous method because runtime is blocked anyway till finish
	exec = require('child_process').exec,
	fs = require('fs'),
	express = require('express'),
	app = express(),
	moment = require('moment'),
	async = require('async'),
	os = require('os'),
	when = require('when'),
	path = require('path');
var timeout = require('connect-timeout');
var compress = require('compression');
var debug = require('debug')('automation:server');
var androidEmulator = require('./lib/android-emulator');
var maintenance = require('./lib/maintenance');
var benchmark = require('./lib/benchmark');
var configOptions = testSetup.configOptions;
const http = require('http');
const serveStatic = require('serve-static');
var serveIndex = require('serve-index');

const helpers = require('./lib/helpers');
const routeSimulation = require('./lib/route-simulation');

const adbClient = android.modifyAdbClient(adb.createClient({port: configOptions.adbTestPort}));

var CSV_FILE = configOptions.userCsvFile;
var lib_PORT = configOptions.deviceServerPort;
var IOS_PACKAGE_NAME = configOptions.iosPackageName;
var benchMarkLogArray = [];
const screencap = require('./lib/screencap');
const ffmpeg = require('./lib/ffmpeg');
const appium = require('./lib/appium');
let RunningConfigObjects = require('./lib/running');
let WebSocketServerObject = {};

debug('server started with options: ' + JSON.stringify(configOptions));
//var APPIUM_SERVER_HOST = 'localhost';
var applicationUserList = [];
var DEFAULT_IOS_VERSION = '9.3';
var xcodeInstallation = {};
//android.trackAndroidDevices(client, configOptions);
//android.checkTcpipConnection(client, configOptions); //TODO shoud do this synchronously
//var spawn = require('child_process').spawn;
const SERVER_RESPONSE_TIMEOUT = 300000;
const DEFAULT_DESIRED_CAPS = configOptions.appiumDefaultCaps;
let SERVER_START_TIME;

function calculateDevicesAndSimulator(emulatorList, emulatorIpadList, iosDeviceList) {

	if (iosDeviceList.error) {
		iosDeviceList = [];
	}
	return emulatorList.length + emulatorIpadList.length + iosDeviceList.length;
}

function start() {
	console.log('running device server on: ' + os.hostname() + ' with port ' + lib_PORT);
	SERVER_START_TIME = moment().unix();
	return app.listen(lib_PORT);
}

function stop() {
	app.close();
}

function updateIosEmulatorVersion(emulator, desiredVersion, options) {
	var xcodeVersion = options.xcodeVersion;
	var maxIosVersion = options.maxIosSdk;
	if (desiredVersion) {
		desiredVersion = desiredVersion.toLowerCase();
		if (desiredVersion === 'latest') {
			debug('using latest desired ios version');
			emulator.platformVersion = maxIosVersion;
		} else if (desiredVersion === '9.0' || desiredVersion === '9') {
			emulator.platformVersion = '9.0';
		} else {
			emulator.platformVersion = desiredVersion;
		}
	} else {
		emulator.platformVersion = DEFAULT_IOS_VERSION;
	}
	return emulator;
}

var logcatGlobal = null;
var instrumentsInUse = false,
	androidDeviceList = [],
	androidEmulatorList = [],
	iosEmulatorList = [],
	iosEmulatorIpadList = [],
	iosSimulatorList = [], //raw xcrun simctl list
	iosDeviceList = [],
	appiumServerList = [],
	inUseDeviceList = [];

function doAndroidSetup() {
	return when.join(
		maintenance.resetKnownAvds(configOptions),
		maintenance.clearBenchMarkDir(configOptions),
		maintenance.clearScreenshotDir(configOptions)
	)
		.then((message) => {
			debug(message);
			debug('Android Environment Version Data: ');
			return android
				.getAndroidVersionData()
				.catch((error) => {
					debug(`error getting android version data but suppressing it: ${error}`);
				});
		})
		.then(() => {
			/*The kill below covers a usb interface dropping bug in ADB on Mac OS for devices,
			 https://code.google.com/p/android/issues/detail?id=219085 AND 200432*/
			// adbClient.connection.on('error',  (error) => {
			//         debug('saving self from being killed from adbClient with error: ' + error);
			//         console.error(error);
			// })
			if (helpers.isWindows() === true) {
				return adbClient.listDevices();
			} else {
				return adbClient
					.kill()
					.then(() => adbClient.listDevices())
					.catch((error) => {
						debug('Error found in doing kill adbClient in start bug suppressing it: ' + error);
						return adbClient.listDevices();
					});
			}
		})
		.then(function (devices) {
			return android.checkAndroidDeviceIsValid(adbClient, devices);
		})
		.then((androids) => {
			debug(androids);
			androidDeviceList = androids.deviceList;
			androidEmulatorList = androids.emulatorList;
		})
		.catch((error) => {
			console.error('Problem getting devices from adb');
			console.error(error.stack);
			console.error(error);
		});
}

function doIosSetup() {
	if (os.platform() === 'darwin' && configOptions.androidOnly === false) {
		return iOS
			.retreiveXcodeInfo()
			.then((xcodeInfo) => {
				xcodeInstallation = xcodeInfo;
				debug(xcodeInstallation);
				if (process.env.DEVELOPER_DIR) {
					debug('DEVELOPER_DIR is set to: ' + process.env.DEVELOPER_DIR);
					if (xcodeInstallation.xcodePath !== process.env.DEVELOPER_DIR) {
						console.error(xcodeInstallation.xcodePath + '!==' + process.env.DEVELOPER_DIR);
						throw new Error('Xcode Paths should match');
					}
				}
				return when.join(
					iOS.retreiveIosDeviceList({iosPackageName: IOS_PACKAGE_NAME}),
					iOS.retreiveSimulatorList(configOptions)
				).then((iosSetup) => {
					iosDeviceList = iosSetup[0];
					iosSimulatorList = iosSetup[1].all;
					iosEmulatorList = iosSetup[1].iphones;
					iosEmulatorIpadList = iosSetup[1].ipads;
				});
			})
			.catch(function (error) {
				debug(`Suppressing error in doIosSetup ${error}`);
				console.error(error.stack);
				return `Running in Android only mode because of ${error}`;
			});
	} else {
		console.log('Running in Android only mode');
		return when.resolve('Running in Android only mode');
	}
}

function doServerSetup() {
	if (configOptions.resetServerPort === true) {
		return helpers
			.doShellKillByPort(configOptions.deviceServerPort, {name: 'node'})
			.tap(debug)
			.catch((error) => {
				debug(`Supressing error in doServerSetup: ${error}`);
			});
	} else {
		return when.resolve('Not doing resetServerPort because its off');
	}
}

function startServer() {
	let startTime = process.hrtime();
	//TODO take the reliance of globals out of android And iOS setup
	return when.join(appium.generateServerList(configOptions), doAndroidSetup(), doIosSetup(), doServerSetup())
		.then((startupResults) => {
			appiumServerList = startupResults[0];
			const serverInstance = start();
			serverInstance.timeout = SERVER_RESPONSE_TIMEOUT; //TODO is this still needed for express4 ?
			let diffTime = process.hrtime(startTime);
			debug('Server Startup Took: %ds %dms', diffTime[0], diffTime[1] / 1000000);
			return serverInstance;
		});
}

function haltOnTimedout(req, res, next) {
	if (!req.timedout) {
		next();
	}
}

app.use(compress());
app.use(express.static(path.join(__dirname, 'static')));
app.use(bodyParser.json());
app.use(timeout('300s'));
app.use(haltOnTimedout);
app.use('/readme.md', express.static(path.join(__dirname, 'readme.md')));

var globalServer;

startServer()
	.then(function (serverInstance) {
		globalServer = serverInstance;
		debug('appium server list:' + JSON.stringify(appiumServerList));
		return testSetup.GetJsonUserList(CSV_FILE).then((userList) => {
			applicationUserList = userList;
			console.log('Server is now running');
			return {message: 'Server is now running'};
		});

	});

function refresh() {
	adbClient.listDevices()
		.then(function (devices) {
			androidDeviceList = devices;
			return androidDeviceList;
		});
}

function processRequestArgs(reqQuery) {
	var overrideUser = reqQuery.overrideUser,
		iosPlatform = reqQuery.iosPlatform,
		customAvdName = reqQuery.customAvdName;


	if (overrideUser) {
		overrideUser = (overrideUser.toLowerCase() === 'true');
		debug('Found override user request param');
	} else {
		overrideUser = false;
	}
	//todo does not make sense todo this for devices
	if (!iosPlatform) {
		iosPlatform = DEFAULT_IOS_VERSION;
	}
	return {overrideUser: overrideUser, iosPlatform: iosPlatform, customAvdName: customAvdName};
}

function returnApplicationUser(userList, userJson, requestArgs) {
	if (requestArgs.overrideUser === true) {
		console.log('Custom user Found so discarding it');
		return userList;
	} else {
		userList.push(userJson);
		return userList;
	}
}

app.get('/', function (req, res) {
	var message = "Jamie's Android device distribution center" + '\n' +
		'Available methods /devices /android-device /ios-device /restart';
	res.json({message: message});
});

app.get('/internal/status', function (req, res) {
	res.json({time: moment().unix(), status: 'running', startTime: SERVER_START_TIME});
});

app.get('/devices', function (req, res) {
	if (androidDeviceList.length > 0 || (iosEmulatorList.length > 0 || iosDeviceList.length > 0)) {
		if (os.platform() === 'darwin' && configOptions.androidOnly === false) {
			res.json({
				androidDeviceCount: androidDeviceList.length,
				'androidDeviceList': androidDeviceList,
				'androidEmulatorList': androidEmulatorList,
				'iosDeviceCount': iosDeviceList.length,
				'iosEmulators': iosEmulatorList,
				'iosIpadEmulators': iosEmulatorIpadList,
				'iosDevices': iosDeviceList
			});
		} else {
			res.json({
				'androidDeviceCount': androidDeviceList.length,
				'androidEmulatorList': androidEmulatorList,
				'androidDeviceList': androidDeviceList
			});
		}
	} else {
		res.status(500).json({error: 'no devices'});
	}
});

app.get('/appium-servers', function (req, res) {
	res.json(appiumServerList);
});

app.get('/application-users', function (req, res) {
	debug(applicationUserList);
	res.json(applicationUserList);
});

app.get('/android', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if (appiumServerList.length > 0) {
		var device = null;
		if (androidDeviceList.length > 0) {
			device = androidDeviceList.pop();
		} else {
			debug('Could not find android device so using emulator');
			if (androidEmulatorList.length > 0) {
				device = androidEmulatorList.pop();
			} else {
				if (configOptions.startAndroidEmulators) {
					debug('Found no emulators so starting one');
					return android
						.startAndSendAndroidEmulatorToClient(configOptions, adbClient, applicationUserList, requestArgs, appiumServerList, inUseDeviceList, res)
						.then((result) => {
							//console.log('in use deviceList server last: ' + JSON.stringify(inUseDeviceList))
							debug('device added to inuse is: ' + JSON.stringify(result));
							inUseDeviceList = result;
						})
						.catch((error) => {
							console.error('something went wrong sending android emulator');
							console.error(error);
						});
				}
			}
		}
		if (!device) {
			console.error('Attempt to get android thing that is not valid that is: ' + device);
			res.status(500).json({error: 'Could not get android device or emulator'});
		} else {
			var appiumServer = appiumServerList.shift();
			var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs);
			android
				.clearLogCat(adbClient, device.id)
				.then(function (client) {
					client
						.getProperties(device.id)
						.then((properties) => {
							if (device.type === 'emulator') {
								return android.getChromeDriver(properties, configOptions);
							} else { //device case
								if (configOptions.customChromeDriverVersion) { //fixed crosswalk version case
									return android.getChromeDriver(properties, configOptions);
								} else {
									return {properties}; //assume device and use chromedriver default
								}
							}
						})
						.then((info) => {
							let properties = info.properties;
							var desiredCaps = {
								platformName: 'Android',
								platformVersion: properties['ro.build.version.release'],
								deviceName: properties['ro.product.model'],
								adbPort: configOptions.adbTestPort,
								udid: device.id,
								//udid: properties["ro.boot.serialno"], rooted/cfw devices dont match device.id
								app: null // will be set later
							};
							if (_.isNil(info.chromeDriverPath) === false) {
								desiredCaps.chromedriverExecutable = info.chromeDriverPath;
							}
							if (configOptions.androidTcpip) {
								desiredCaps.androidDeviceReadyTimeout = 60;
								desiredCaps.deviceReadyTimeout = 15;
							}
							var defaultCaps = _.defaults(_.clone(appiumServer.desiredCaps), _.clone(android.DEFAULT_ANDROID_CAPS));
							appiumServer.desiredCaps = _.merge(defaultCaps, desiredCaps);
							var androidJson = {
								applicationUser: applicationUser,
								appium: appiumServer,
								serial: device.id,
								type: device.type,
								properties: android.returnFilteredDeviceProperties(properties),
								deviceName: properties['ro.product.model'],
								deviceType: properties['ro.build.characteristics'],
								sdkVersion: parseInt(properties['ro.build.version.sdk']),
								testPlatform: 'Android',
								testPlatformName: 'Android-device-' + desiredCaps.platformVersion + '-' + desiredCaps.deviceName
							};
							if(android.isStockAvd(device, properties)){
								androidJson.port = android.getAvdPortfromName(device.id);
							}
							inUseDeviceList.push(androidJson);
							console.log('sent ' + device.type + ' to test for android');
							res.json(androidJson);
						})
						.catch(function (err) {
							console.error('Something went wrong getting device or emulator information :', err.stack);
							res.status(500).json({error: err.message});
						});
				});
		}
	} else {
		console.error('attempt to get android  when no appium servers available.');
		res.status(500).json({error: 'no devices or appium servers'});
	}
});

app.get('/android-emulator', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if ((androidEmulatorList.length > 0 && appiumServerList.length > 0) && !requestArgs.customAvdName) {
		var emulatorFound = androidEmulatorList.pop();
		android
			.runningTimeReached(emulatorFound, configOptions)
			.then((needRestart) => {
				if (needRestart) {
					debug('restarting emulator because max running time exceed');
					return android.restartAndroid(emulatorFound, configOptions);
				} else {
					debug('emulator restart not needed');
					return emulatorFound;
				}
			})
			.then((emulator) => {
				var appiumServer = appiumServerList.shift();
				var applicationUser = helpers.getapplicationUser(applicationUserList, requestArgs);
				android
					.clearLogCat(adbClient, emulator.id)
					.then(function (client) {
						client
							.getProperties(emulator.id)
							.then((properties) => {
								return android.getChromeDriver(properties, configOptions);
							})
							.then((info) => {
								let properties = info.properties;
								var desiredCaps = {
									platformName: 'Android',
									adbPort: configOptions.adbTestPort,
									platformVersion: properties['ro.build.version.release'],
									deviceName: properties['ro.product.model'],
									udid: emulator.id,
									app: null // will be set later

								};
								if (_.isUndefined(info.chromeDriverPath) === false) {
									desiredCaps.chromedriverExecutable = info.chromeDriverPath;
								}
								var defaultCaps = _.defaults(_.clone(appiumServer.desiredCaps), _.clone(android.DEFAULT_ANDROID_CAPS));
								appiumServer.desiredCaps = _.merge(defaultCaps, desiredCaps);
								var androidJson = {
									applicationUser: applicationUser,
									appium: appiumServer,
									serial: emulator.id,
									type: emulator.type,
									port: android.getAvdPortfromName(emulator.id),
									properties: android.returnFilteredDeviceProperties(properties),
									deviceName: properties['ro.product.model'],
									deviceType: properties['ro.build.characteristics'],
									sdkVersion: parseInt(properties['ro.build.version.sdk']),
									testPlatform: 'Android',
									testPlatformName: 'Android-emu-' + desiredCaps.platformVersion + '-' + desiredCaps.deviceName

								};
								inUseDeviceList.push(androidJson);
								console.log('sent android to test');
								res.json(androidJson);
							})
							.catch(function (err) {
								console.error('Something went wrong getting android emulator:', err.stack);
								res.status(500).json({error: err.stack});
							});
					});
			})
			.catch(function (error) {
				console.error('Something went wrong getting android emulator:', error.stack);
				res.status(500).json({error: error.message});
			});
	} else {
		//TODO 16GB mac minis do not have memory to launch multiple haxm emulators should prevent the launching of multiple
		if (configOptions.startAndroidEmulators) {
			debug('startAndroidEmulators is Set');
			return android
				.startAndSendAndroidEmulatorToClient(configOptions, adbClient, applicationUserList, requestArgs, appiumServerList, inUseDeviceList, res)
				.then((result) => {
					//console.log('in use deviceList server last: ' + JSON.stringify(inUseDeviceList))
					debug('device added to inuse is: ' + JSON.stringify(result));
					inUseDeviceList = result;
				})
				.catch((error) => {
					console.error('something went wrong sending android emulator');
					console.error(error);
				});
		} else {
			console.error('attempt to get android emulator when none available.');
			res.status(500).json({error: 'no android devices'});
		}

	}
});

app.get('/android-device', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if (androidDeviceList.length > 0 && appiumServerList.length > 0) {
		var device = androidDeviceList.pop();
		var appiumServer = appiumServerList.shift();
		var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs);
		android
			.clearLogCat(adbClient, device.id)
			.then(function (client) {
				client
					.getProperties(device.id)
					.then(function (properties) {
						var desiredCaps = {
							platformName: 'Android',
							platformVersion: properties['ro.build.version.release'],
							deviceName: properties['ro.product.model'],
							adbPort: configOptions.adbTestPort,
							udid: device.id,
							//udid: properties["ro.boot.serialno"], rooted/cfw devices dont match device.id
							app: null // will be set later
						};
						//var defaultCaps = _.clone(appiumServer.desiredCaps);
						var defaultCaps = _.defaults(_.clone(appiumServer.desiredCaps), _.clone(android.DEFAULT_ANDROID_CAPS));
						appiumServer.desiredCaps = _.merge(defaultCaps, desiredCaps);
						var androidJson = {
							applicationUser: applicationUser,
							appium: appiumServer,
							serial: device.id,
							type: device.type,
							properties: android.returnFilteredDeviceProperties(properties),
							deviceName: properties['ro.product.model'],
							deviceType: properties['ro.build.characteristics'],
							sdkVersion: parseInt(properties['ro.build.version.sdk']),
							testPlatform: 'Android',
							testPlatformName: 'Android-device-' + desiredCaps.platformVersion + '-' + desiredCaps.deviceName
						};
						inUseDeviceList.push(androidJson);
						console.log('sent android to test');
						res.json(androidJson);
					})
					.catch(function (err) {
						console.error('Something went wrong getting device:', err.stack);
						res.status(500).json({error: err.stack});
					});
			});
	} else {
		console.error('attempt to get android device when none available.');
		res.status(500).json({error: 'no devices'});
	}
});

app.get('/ios-emulator', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if (os.platform() === 'darwin' && !instrumentsInUse) {
		if (iosEmulatorList.length !== 0 && appiumServerList.length > 0) {
			var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs),
				appiumServer = (appiumServerList.shift()),
				iosEmulator = iosEmulatorList.pop();
			iosEmulator = updateIosEmulatorVersion(iosEmulator, requestArgs.iosPlatform, xcodeInstallation);
			appiumServer.desiredCaps = _.merge(_.clone(appiumServer.desiredCaps), iosEmulator);
			var iosJson = {
				applicationUser: applicationUser,
				appium: appiumServer,
				type: 'simulator',
				testPlatform: 'ios-emulator',
				deviceType: iOS.getSimulatorDeviceType(iosEmulator),
				deviceName: iosEmulator.deviceName,
				deviceVersion: iosEmulator.platformVersion,
				sdkVersion: iOS.parseIosVerson(iosEmulator.platformVersion),
				serial: testSetup.getSimulatorUdid(iosSimulatorList, iosEmulator.deviceName, iosEmulator.platformVersion),
				testPlatformName: 'iOS-sim-' + iosEmulator.platformVersion + '-' + iosEmulator.deviceName
			};
			if (xcodeInstallation.xCodeVersionNumber >= 8) {
				iosJson.appium.desiredCaps.automationName = 'XCUITest';
			}
			inUseDeviceList.push(iosJson);
			console.log('sent ios emulator to test');
			instrumentsInUse = true;
			res.json(iosJson);
		} else {
			console.error('attempt to get ios emulator or appium server when none available.');
			res.status(500).json({error: 'no emulators or appium servers available'});
		}
	} else {
		if (instrumentsInUse) {
			res.status(500).json({error: 'xcode instruments is in use so cannot send device'});
		} else {
			res.status(500).json({error: 'using incompatible OS'});
		}
	}
});

app.get('/ios-emulator-ipad', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if (os.platform() === 'darwin' && !instrumentsInUse) {
		if (iosEmulatorIpadList.length !== 0 && appiumServerList.length > 0) {
			var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs),
				appiumServer = (appiumServerList.shift()),
				iosEmulator = iosEmulatorIpadList.pop();
			iosEmulator = updateIosEmulatorVersion(iosEmulator, requestArgs.iosPlatform, xcodeInstallation);
			appiumServer.desiredCaps = _.merge(_.clone(appiumServer.desiredCaps), iosEmulator);
			var iosJson = {
				applicationUser: applicationUser,
				appium: appiumServer,
				type: 'simulator',
				deviceType: 'iPad',
				deviceName: iosEmulator.deviceName,
				deviceVersion: iosEmulator.platformVersion,
				sdkVersion: iOS.parseIosVerson(iosEmulator.platformVersion),
				testPlatform: 'ios-emulator-ipad',
				serial: testSetup.getSimulatorUdid(iosSimulatorList, iosEmulator.deviceName, iosEmulator.platformVersion),
				testPlatformName: 'iOS-sim-' + iosEmulator.platformVersion + '-' + iosEmulator.deviceName
			};
			if (xcodeInstallation.xCodeVersionNumber >= 8) {
				iosJson.appium.desiredCaps.automationName = 'XCUITest';
			}
			inUseDeviceList.push(iosJson);
			console.log('sent ios ipad emulator to test');
			instrumentsInUse = true;
			res.json(iosJson);
		} else {
			console.error('attempt to get ios ipad emulator when none available.');
			res.status(500).json({error: 'no ipad emulators available'});
		}
	} else {
		if (instrumentsInUse) {
			res.status(500).json({error: 'xcode instruments is in use so cannot send device'});
		} else {
			res.status(500).json({error: 'using incompatible OS'});
		}
	}
});

app.get('/ios-device', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	if (os.platform() === 'darwin' && !instrumentsInUse) {
		if ((iosDeviceList.length !== 0 && appiumServerList.length > 0) && !iosDeviceList.error) {
			var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs),
				appiumServer = (appiumServerList.shift()),
				iosDevice = iosDeviceList.pop();
			appiumServer.desiredCaps = _.merge(_.clone(appiumServer.desiredCaps), iosDevice.desired);
			var platformVersion = appiumServer.desiredCaps.platformVersion;
			var iosJson = {
				applicationUser: applicationUser,
				appium: appiumServer,
				serial: iosDevice.deviceSerial,
				deviceName: iosDevice.deviceName,
				deviceType: iosDevice.deviceType,
				deviceVersion: platformVersion,
				sdkVersion: iOS.parseIosVerson(platformVersion),
				type: 'device',
				testPlatform: 'ios-device',
				testPlatformName: 'iOS-device-' + platformVersion + '-' + iosDevice.deviceType
			};
			if (xcodeInstallation.xCodeVersionNumber >= 8) {
				iosJson.appium.desiredCaps.automationName = 'XCUITest';
			}
			inUseDeviceList.push(iosJson);
			instrumentsInUse = true;
			console.log('sent ios device to test');
			res.json(iosJson);
		} else {
			//TODO tidy up this better
			if (iosDeviceList.error) {
				console.error('attempt to get ios device when none available.');
				res.status(500).json({error: iosDeviceList.error});
			} else {
				console.error('Encountered unknown error in /ios-device');
				res.status(500).json({error: 'no ios devices available'});
			}
		}
	} else {
		if (instrumentsInUse) {
			res.status(500).json({error: 'xcode instruments is in use so cannot send device'});
		} else {
			res.status(500).json({error: 'using incompatible OS'});
		}
	}
});

/*Endpoint to ask for ios device and fallback to simulator if no devices*/
app.get('/ios', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	var deviceAndSimulatorAvail = calculateDevicesAndSimulator(iosEmulatorList, iosEmulatorIpadList, iosDeviceList);
	if (os.platform() === 'darwin' && !instrumentsInUse) {
		if (appiumServerList.length > 0 && deviceAndSimulatorAvail > 0) {
			var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs),
				appiumServer = (appiumServerList.shift());
			var testPlatformName = null;
			var iosDevice, type, testPlatform, deviceUdid, deviceVersion;
			if (iosDeviceList.length > 0 && !iosDeviceList.error) {
				iosDevice = iosDeviceList.pop();
				type = 'device';
				testPlatform = 'ios-device';
				appiumServer.desiredCaps = _.merge(_.clone(appiumServer.desiredCaps), iosDevice.desired);
				deviceUdid = iosDevice.deviceSerial;
				var platformVersion = appiumServer.desiredCaps.platformVersion;
				testPlatformName = 'iOS-device-' + platformVersion + '-' + iosDevice.deviceType;
				deviceVersion = platformVersion;
			} else {
				console.log('could not find connected ios device, using emulator');
				var iosEmulator = iosEmulatorList.pop();
				iosDevice = updateIosEmulatorVersion(iosEmulator, requestArgs.iosPlatform, xcodeInstallation);
				iosDevice.deviceType = iOS.getSimulatorDeviceType(iosEmulator);
				type = 'simulator';
				testPlatform = 'ios-emulator';
				appiumServer.desiredCaps = _.merge(appiumServer.desiredCaps, iosDevice);
				deviceUdid = testSetup.getSimulatorUdid(iosSimulatorList, iosDevice.deviceName, iosDevice.platformVersion);
				testPlatformName = 'iOS-sim-' + iosEmulator.platformVersion + '-' + iosEmulator.deviceName;
				deviceVersion = iosEmulator.platformVersion;
			}
			var iosJson = {
				applicationUser: applicationUser,
				appium: appiumServer,
				serial: deviceUdid,
				deviceName: iosDevice.deviceName,
				deviceType: iosDevice.deviceType,
				deviceVersion: deviceVersion,
				sdkVersion: iOS.parseIosVerson(deviceVersion),
				testPlatform: testPlatform,
				testPlatformName: testPlatformName,
				//-waitForAppScript :'$.delay(10000); $.acceptAlert();  true;',
				type: type
			};
			if (xcodeInstallation.xCodeVersionNumber >= 8) {
				iosJson.appium.desiredCaps.automationName = 'XCUITest';
			}
			inUseDeviceList.push(iosJson);
			instrumentsInUse = true;
			console.log('sent ios ' + type + ' to test');
			res.json(iosJson);
		} else {
			//TODO tidy up this better
			if (iosDeviceList.error) {
				console.error('attempt to get ios device when none available.');
				res.status(500).json({error: iosDeviceList.error});
			} else {
				console.error('Encountered unknown problem in /ios');
				res.status(500).json({error: 'no ios devices available'});
			}
		}
	} else {
		if (instrumentsInUse) {
			res.status(500).json({error: 'xcode instruments is in use so cannot send device'});
		} else {
			res.status(500).json({error: 'using incompatible OS'});
		}
	}
});

//TODO get this working again with refactoring
// app.get('/refresh', function (req, res) {
// 	res.status(500).json({error: 'endpoint not yet complete'});
// 	adbClient.listDevices()
// 		.then(function (devices) {
// 			android.checkAndroidDeviceIsValid(adbClient, devices, function (devices) {
// 				if (androidDeviceList.length !== devices.length) {
// 					androidDeviceList = devices;
// 				}
// 				iOS.retreiveIosDeviceList({iosPackageName: IOS_PACKAGE_NAME}, function (iosDevices) {
// 					if (iosDeviceList.length !== iosDevices.length) {
// 						iosDeviceList = iosDevices;
// 					}
// 				});
// 			});
// 		});
// });


//TODO get this working again with refactoring
// app.get('/restart', function (req, res) {
// 	console.log('Attempting Restart');
// 	androidDeviceList.length = 0;
// 	androidEmulatorList.length = 0;
// 	appiumServerList.length = 0;
// 	applicationUserList.length = 0;
// 	inUseDeviceList.length = 0;
// 	applicationUserList = testSetup.GetJsonUserList(CSV_FILE);
// 	appiumServerList = generateServerList(APPIUM_SERVER_NUM, START_PORT);
// 	adbClient.listDevices()
// 		.then(function (devices) {
// 			return android
// 				.checkAndroidDeviceIsValid(adbClient, devices)
// 				.then((androids) => {
// 					console.log(androids);
// 					androidDeviceList = androids.deviceList;
// 					androidEmulatorList = androids.emulatorList;
// 					iOS.retreiveIosDeviceList({iosPackageName: IOS_PACKAGE_NAME}, function (iosDevices) {
// 						if (os.platform() === 'darwin' && configOptions.androidOnly === false) {
// 							instrumentsInUse = false;
// 							iosEmulatorList.length = 0;
// 							iosEmulatorIpadList.length = 0;
// 							iosDeviceList.length = 0;
// 							testSetup.retreiveSimulatorList(configOptions, function (emulatorList) {
// 								iosSimulatorList = emulatorList.all;
// 								iosEmulatorList = emulatorList.iphones;
// 								iosEmulatorIpadList = emulatorList.ipads;
// 								iosDeviceList = iosDevices;
// 								if (iosDeviceList.error) {
// 									console.error(iosDeviceList.error);
// 									iosDeviceList.length = 0;
// 								}
// 								res.json({
// 									android: (androidDeviceList.length).toString() + ' Devices found',
// 									androidEmulators: (androidEmulatorList.length).toString() + ' emulators found',
// 									iosDevices: (iosDeviceList.length).toString() + ' Devices found',
// 									iosEmulators: (iosEmulatorList.length).toString() + ' Devices found'
// 								});
// 							});
// 						} else {
// 							res.json({
// 								android: (androidDeviceList.length).toString() + ' Devices found',
// 								androidEmulators: (androidEmulatorList.length).toString() + ' emulators found'
// 							});
// 						}
// 					});
// 				});
// 		});
// });

app.get('/connected', function (req, res) {
	adbClient.listDevices()
	//todo displays devices that arnt capable of running like api < 18
		.then(function (devices) {
			res.send(devices);
		});

});

app.get('/in-use', function (req, res) {
	const util = require('util');
	res.json({devices: inUseDeviceList, benchmarks: util.inspect(benchMarkLogArray, {showHidden: false, depth: 5})});
});

app.post('/finished/ios-emulator', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	var userJson = req.body.applicationUser;
	var appiumJson = req.body.appiumServer;
	var deviceJson = req.body.device;
	debug('received finished post body ios-em: ' + JSON.stringify(req.body));
	instrumentsInUse = false;
	if (userJson.account) {
		console.log('received ios thing to re add:');
		applicationUserList = returnApplicationUser(applicationUserList, userJson, requestArgs); //TODO probaly should error check
		if (appiumJson.host) {
			appiumJson.desiredCaps = _.clone(DEFAULT_DESIRED_CAPS);
			for (var i = 0; i < inUseDeviceList.length; ++i) {
				if (inUseDeviceList[i].appium.port === appiumJson.port) {
					iosEmulatorList.unshift(deviceJson.desiredCaps); //TODO remove serial?
					inUseDeviceList.splice(i--, 1);
					console.log('removed in use ios emulator by appium port');
				}
			}
			appiumServerList.unshift(appiumJson);
			// console.log(appiumServerList);
			res.json({message: 'ios emulator added back into the pool'});
		}
	} else {
		console.error('could not add device back into pool');
		console.error('requestArgs:' + JSON.stringify(requestArgs) + ' reqBody:' + JSON.stringify(req.body));
		res.status(500).json({message: 'could not add device back into pool'});
	}
});

app.post('/finished/ios-emulator-ipad', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	var userJson = req.body.applicationUser;
	var appiumJson = req.body.appiumServer;
	var deviceJson = req.body.device;
	debug('received finished post body ios-em ipad: ' + JSON.stringify(req.body));
	instrumentsInUse = false;
	if (userJson.account) {
		console.log('received ios emulator thing to re add:');
		applicationUserList = returnApplicationUser(applicationUserList, userJson, requestArgs);
		if (appiumJson.host) {
			appiumJson.desiredCaps = _.clone(DEFAULT_DESIRED_CAPS);
			for (var i = 0; i < inUseDeviceList.length; ++i) {
				if (inUseDeviceList[i].appium.port === appiumJson.port) {
					iosEmulatorIpadList.unshift(deviceJson.desiredCaps);
					inUseDeviceList.splice(i--, 1);
					console.log('removed in use ios ipad emulator by appium port');
				}
			}
			appiumServerList.unshift(appiumJson);
			// console.log(appiumServerList);
			res.json({message: 'ios ipad emulator added back into the pool'});
		}
	} else {
		res.status(500).json({message: 'could not add ios emulator ipad device back into pool'});
	}
});

app.post('/finished/ios-device', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	var deviceJson = req.body.device;
	var userJson = req.body.applicationUser;
	var appiumJson = req.body.appiumServer;
	instrumentsInUse = false;
	debug('received finished post body ios-device: ' + JSON.stringify(req.body));
	if (deviceJson.deviceSerial && deviceJson.type) {
		iosDeviceList.push(deviceJson);
		console.log('received ios device to re add:' + deviceJson.deviceSerial);
		for (var i = 0; i < inUseDeviceList.length; ++i) {
			if (inUseDeviceList[i].serial === deviceJson.deviceSerial) {
				inUseDeviceList.splice(i--, 1);
				console.log('added ios device back into the pool');
			}
		}
		// console.log(deviceList);
		if (userJson.account) {
			applicationUserList = returnApplicationUser(applicationUserList, userJson, requestArgs);
			//console.log(applicationUserList);
			if (appiumJson.host) {
				appiumJson.desiredCaps = _.clone(DEFAULT_DESIRED_CAPS);
				appiumServerList.unshift(appiumJson);
				// console.log(appiumServerList);
				res.json({message: 'ios device added back into the pool'});
			}
		}
	} else {
		res.status(500).json({message: 'could not add ios device back into pool'});
	}
});

app.post('/finished/android', function (req, res) {
	var requestArgs = processRequestArgs(req.query);
	var deviceJson = req.body.device;
	var userJson = req.body.applicationUser;
	var appiumJson = req.body.appiumServer;
	debug('received finished post body android: ' + JSON.stringify(req.body));
	if (deviceJson.id && deviceJson.type) {
		for (var i = 0; i < inUseDeviceList.length; ++i) {
			if (inUseDeviceList[i].serial === deviceJson.id) {
				inUseDeviceList.splice(i--, 1);
				console.log('removed in use device');
			}
		}
		if (userJson.account) {
			applicationUserList = returnApplicationUser(applicationUserList, userJson, requestArgs);
			if (appiumJson.host) {
				appiumJson.desiredCaps = _.clone(DEFAULT_DESIRED_CAPS);
				appiumServerList.unshift(appiumJson);
				if (configOptions.turnOffAvds && deviceJson.type === 'emulator') {
					debug('turn off emulator:' + JSON.stringify(deviceJson));
					return androidEmulator
						.stop({serial: deviceJson.id})
						.finally(() => {
							debug('stopped emulator');
							res.json({message: 'emulator turned off and not added into the pool'});
						});
				} else if (deviceJson.type === 'emulator') {
					androidEmulatorList.push(deviceJson);
					res.json({message: 'emulator added back into the pool'});
				} else {
					androidDeviceList.push(deviceJson);
					res.json({message: 'device added back into the pool'});
				}
			}
		}
	} else {
		console.error('could not add device back into pool');
		console.error('requestArgs:' + JSON.stringify(requestArgs) + ' reqBody:' + JSON.stringify(req.body));
		res.status(500).json({message: 'could not add device back into pool'});
	}
});

app.post('/android-shell', function (req, res) {
	var serial = req.body.serial,
		command = req.body.command;
	console.log('performing shell command: ' + command + ' For device: ' + serial);
	adbClient.shell(serial, command)
		.then(adb.util.readAll)
		.then(function (output) {
			debug('android-shell output: [%s] %s', serial, output.toString().trim());
			res.json({status: 'success', output: output.toString().trim()});
		})
		.catch(function (error) {
			console.error('Something went wrong doing POST android-shell:' + JSON.stringify(error));
			res.status(500).json({message: 'Something went wrong doing POST android-shell:' + JSON.stringify(error)});
		});
});


app.post('/android-route-simulate', async function (req, res) {
	const device = req.body.device, //expect the form  { id": "emulator-5574","type": "emulator"}
		fileName = req.body.fileName;
	const sendLocationIntervalMs = req.body.sendLocationIntervalMs;
	const timeToRunMins = req.body.timeToRunMins || 60;
	const simulateOptions = {fileName, sendLocationIntervalMs, timeToRunMins};
	console.log('performing android-route-simulate for file: ' + fileName + ' For device: ' + JSON.stringify(device));
	try{
		let portResult = await android.checkAndroidEmulatorPort(device.port);
		debug(portResult);
	} catch(error){
		debug(`Could not telent connect to specified emulator ${JSON.stringify(device)}`);
		res.status(500).json({message: `Could not telent connect to specified emulator ${JSON.stringify(device)}`});
		return;
	}
	routeSimulation
		.androidSimulateLocationRoute(device, simulateOptions, configOptions)
		.then((result) => {
			debug(result);
			res.json(result);
		})
		.catch(function (error) {
			console.error(error.stack);
			console.error('Something went wrong doing POST android-route-simulate:' + error.message);
			res.status(500).json({message: 'Something went wrong doing POST android-route-simulate:' + error.message, stack: error.stack});
		});
});





app.post('/ios-sim-erase', function (req, res) {
	var udid = req.body.serial;
	//TODO handle situation if device doesn't shutdown due to bugged xcrun simctl
	iOS
		.shutDownSimulators()
		.then((message) => {
			debug(message);
			return iOS
				.shutdownSim(udid)
				.then(() => {
					return iOS.eraseSim(udid);
				})
				.then(() => {
					res.json({message: 'Success ios-sim-erase: ' + udid});
				})
				.catch((shudownEraseError) => {
					console.error(`could not shutdown or erase device, likely already shutdown ${shudownEraseError}`);
					return iOS
						.eraseSim(udid)
						.then(function () {
							debug('erased: ' + udid);
							res.json({message: 'Success at cleaning simulator but with shutdownError: ' + udid});
						})
						.catch((eraseError) => {
							debug(eraseError);
							res.status(500).json({
								error: 'error at cleaning simulator: ' + udid,
								message: eraseError.message
							});
						});
				});
		})
		.catch((error) => {
			console.log(error);
			res.status(500).json({error: 'error at erasing simulator: ' + udid, 'message:': error.message});
		});

});


//unix only should come up with multi platform
app.post('/clean-android-environment', function (req, res) {
	debug('Running clean-android-environment');
	return android
		.shutDownAllAvds()
		.then((message) => {
			debug('clean-android-environment sucess');
			androidEmulatorList.length = 0;
			res.json({message: 'success at cleaning android environment: ' + JSON.stringify(message)});
		})
		.catch((error) => {
			debug('clean-android-environment problem: ' + JSON.stringify(error));
			res.status(500).json({message: 'problem cleaning android environment: ' + JSON.stringify(error)});
		});
});

app.post('/clean-ios-environment', function (req, res) {
	debug('Running clean-ios-environment');
	return iOS
		.shutDownSimulators()
		.then((message) => {
			debug(message);
			instrumentsInUse = false;
			iosEmulatorList.length = 0;
			iosEmulatorIpadList.length = 0;
			debug('clean-ios-environment success');
			res.json({message: 'success at cleaning ios environment: ' + JSON.stringify(message)});
		})
		.catch((error) => {
			debug('clean-ios-environment problem: ' + JSON.stringify(error));
			res.status(500).json({message: 'problem cleaning ios environment: ' + JSON.stringify(error)});
		});
});

//boot up new android emulator
//TODO merge this new device into the in-use list emulator.stop will fail until this is fixed.
app.post('/replacement-android-emulator', function (req, res) {
	var desiredCaps = _.cloneDeep(req.body);
	if (!desiredCaps.platformVersion || !desiredCaps.deviceName || !desiredCaps.udid) {
		console.error('Need to specifiy "platformVersion, deviceName and udid" for replacement-android-emulator');
		res.status(500).json('Need to specifiy "platformVersion, deviceName and udid" for replacement-android-emulator');
		throw new Error('Need to specifiy "platformVersion, deviceName and udid" for replacement-android-emulator');
	}
	android
		.getReplacementEmulator(desiredCaps, adbClient, configOptions)
		.then((newCaps) => {
			debug('replacement-android-emulator sucess with: ' + JSON.stringify(newCaps));
			res.json(newCaps);
		})
		.catch((error) => {
			debug('problem doing replacement-android-emulator: ' + JSON.stringify(error));
			res.status(500).json({message: 'problem doing replacement-android-emulator: ' + JSON.stringify(error)});
		});
});

//TODO need error handling or any replacment?
app.post('/replacement-ios-emulator', function (req, res) {
	var desiredCaps = _.cloneDeep(req.body);
	res.json(desiredCaps);
});


app.post('/android-clear-pm', function (req, res) {
	var serial = req.body.serial,
		packageName = req.body.packageName;
	console.log('performing pm clear for : ' + packageName + ' For device: ' + serial);
	adbClient.clear(serial, packageName)
		.then(function (err) {
			if (err) {
				console.log(err);
				res.json('error');
			} else {
				console.log('success clearing data package for: ' + serial + packageName);
				res.json('success');
			}
		})
		.catch(function (error) {
			console.error('Something went wrong:' + JSON.stringify(error));
			res.status(500).json({message: 'Something went wrong doing POST android-clear-pm:' + JSON.stringify(error)});
		});
});

app.post('/start-benchmark-android', function (req, res) {
	var serial = req.body.serial;
	var application = req.body.application;
	let benchmarkExpireTimeMinutes;
	if (req.body.benchmarkExpireTimeMinutes) {
		benchmarkExpireTimeMinutes = req.body.benchmarkExpireTimeMinutes;
	} else {
		benchmarkExpireTimeMinutes = 90;
	}
	if (!serial || !application) {
		res.status(500).json({message: 'error does not have serial or application'});
		throw new Error('error does not have serial or application');
	}
	var timeToExpire = moment().add(benchmarkExpireTimeMinutes, 'm').toISOString();
	var checkIfDeviceInBench = _.find(benchMarkLogArray, function (object) {
		return object.memoryFile.serial === serial;
	});
	if (checkIfDeviceInBench) {
		res.status(226).json({
			message: 'Device is already being benched ',
			memoryFile: checkIfDeviceInBench.memoryFile
		});
		console.warn('Device is already being benched' + JSON.stringify(checkIfDeviceInBench.memoryFile));
		return;
	}
	benchmark
		.startAndroidMemoryLogging(adbClient, serial, timeToExpire, application, configOptions)
		.then((memoryObject) => {
			var memoryFile = memoryObject.memoryFile;
			memoryFile.serial = serial;
			benchMarkLogArray.push(memoryObject);
			debug('starting benchMark using: ' + JSON.stringify({
					memoryFile: memoryFile,
					expireTime: timeToExpire,
					application: application
				}));
			res.status(202).json({
				message: 'success',
				memoryFile: memoryFile,
				expireTime: timeToExpire,
				application: application
			});
		})
		.timeout(60000)
		.catch((error) => {
			res.status(500).json({message: 'problem doing startAndroidMemoryLogging: ' + error});
		});
});

app.get('/get-benchmark-android/:id', function (req, res) {
	var benchmarkId = req.params.id;
	var benchmarkObject = _.find(benchMarkLogArray, function (object) {
		return object.memoryFile.id === benchmarkId;
	});
	if (!benchmarkObject) {
		res.status(500).json({message: 'Cannot find the specified benchmarkId: ' + benchmarkId});
		console.error('Cannot find the specified benchmarkId: ' + benchmarkId);
		return;
	}
	debug('stopping benchmarking for: ' + benchmarkId + ' and removing from list');
	//TODO make this configurable
	var deviceIndex = _.findIndex(benchMarkLogArray, (object) => {
		return object.memoryFile.id === benchmarkId;
	});
	// _.remove(benchMarkLogArray, function (object) {
	//     return object.memoryFile.id === benchmarkId;
	// });
	clearInterval(benchmarkObject.intervalId);
	if (deviceIndex >= 0) {
		debug('removing serial ' + benchMarkLogArray[deviceIndex].memoryFile.serial + ' from benchmark: ' + benchMarkLogArray[deviceIndex].memoryFile.id);
		//detach serial from benchmark but keep it in memory //Why did i do this?
		benchMarkLogArray[deviceIndex].memoryFile.serial = null;
	}
	benchmark
		.processMemoryUsageFromFile(benchmarkObject.memoryFile.path)
		.then((memory) => {
			var newMemory = benchmark.calculateMemoryStats(memory);
			res.json({message: 'success', memoryJson: newMemory});
		})
		.timeout(60000)
		.catch((error) => {
			console.error('problem doing startAndroidMemoryLogging: ' + error);
			console.error(error.stack);
			res.status(500).json({message: 'problem doing startAndroidMemoryLogging: ' + error});
		});
});

app.post('/get-heap-android', function (req, res) {
	const serial = req.body.serial;
	const application = req.body.application;
	benchmark
		.getAndSendHeap(adbClient, serial, application, res)
		.then((result) => {
			debug(result);
		})
		.timeout(60000)
		.catch((error) => {
			console.error('problem doing getHeap: ' + error);
		});
});

app.get('/logcat/:id', function (req, res) {
	var stringList = ['TiA', 'TiE', 'TiH', 'TiW'];
	var deviceSerial = req.params.id;
	adbClient.openLogcat(deviceSerial).then(function (logcatInstance) {
		logcatGlobal = logcatInstance;
		// console.log(logcat);
		res.setHeader('content-type', 'text/plain');
		//   res.writeHead(200, {"Content-Type" : "text/plain"});
		logcatInstance.on('entry', function (entry) {
			stringList.forEach(function (partialString) {
				if (_.includes(entry.tag, partialString)) {
					var text = (entry.date + ' ' + entry.priority + ' ' + entry.tag + ' ' + entry.message) + '\n';
					// res.writeHead(200, {"Content-Type" : "text/plain"});
					try {
						console.log(text);
						res.write(text);
					}
					catch (err) {
						console.log(err);

					}
				}
			});
		});
	});
});

app.use('/watch', express.static(path.join(__dirname, 'lib', 'public')));
app.use('/results', serveIndex('results', {'icons': true}));
app.use('/results', serveStatic('results'));


app.get('/android-screen-record/:id', function (req, res) {
	var deviceSerial = req.params.id;
	//screenViewer.init(adbClient, deviceSerial);
	RunningConfigObjects.addDeviceToConfig(deviceSerial);
	RunningConfigObjects.startScreenshots(deviceSerial);
	return screencap
		.startScreencapSocket(adbClient, deviceSerial, configOptions)
		.then((output) => {
			WebSocketServerObject[deviceSerial] = output.socketServer;
			debug(output.message);
			res.json({message: 'Screen recording started'});
		})
		.catch((error) => {
			debug(error);
			res.status(500).json({message: 'screen recording failed', error: error.message, stack: error.stack});
		});

	// res.send(express.static(path.join(__dirname,'lib', 'public')))

});

app.get('/android-video/:id', function (req, res) {
	const deviceSerial = req.params.id;
	const screenshotDir = path.resolve(configOptions.screenshotDir, deviceSerial);
	debug('finding video for : ' + deviceSerial + ' at path: ' + screenshotDir);
	res.contentType('mp4');
	RunningConfigObjects.stopScreenshots(deviceSerial);
	const runningConfig = RunningConfigObjects.getDevice(deviceSerial);
	if (_.isObject(runningConfig) === false) {
		res.status(500).json({
			error: 'Tried to record a video on invalid android serial',
			config: runningConfig,
			serial: deviceSerial
		});
	}
	debug(runningConfig);
	const totalFrameCount = runningConfig.screenshotFrameCount;
	let realTimeDuration = moment().unix() - runningConfig.screenRecordStartTime;
	let compressedTime = _.round(realTimeDuration * 0.2);
	debug('Total frameRatecount for device: ' + deviceSerial + ' is: ' + totalFrameCount +
		' realTimeDuration is: ' + realTimeDuration + ' and compressedTime is: ' + compressedTime);
	let calculatedFps = _.round(totalFrameCount / compressedTime);
	if (calculatedFps <= 5) {
		debug('Calculated fps is too small at: ' + calculatedFps + ' so defaulting to 10');
		calculatedFps = 8;
	}
	const outputFps = Math.min(calculatedFps, 25);
	let videoOptions = {crf: '30', fps: outputFps};
	return ffmpeg
		.createVideoFromFramesSave('%05d.jpg', screenshotDir, path.resolve('tmp', deviceSerial + '.mp4'), videoOptions)
		.then((output) => {
			debug(output);
			let videoStream = fs.createReadStream(output);
			videoStream.pipe(res);
			debug('Trying to close socket Server for : ' + deviceSerial);
			return screencap.closeSocketServer(WebSocketServerObject[deviceSerial]);
		})
		.catch((error) => {
			console.error('android-video error: ' + error);
			res.status(500).json({message: 'getting video recording failed', error: error.message, stack: error.stack});
		});
});

app.post('/android-video/:id', function (req, res) {
	const deviceSerial = req.params.id;
	const screenshotDir = path.resolve(configOptions.screenshotDir, deviceSerial);
	const videoOptions = req.body;
	debug(`Got post custom android-video options ${JSON.stringify(req.body)}`);
	debug('finding Post video for : ' + deviceSerial + ' at path: ' + screenshotDir);
	res.contentType('mp4');
	RunningConfigObjects.stopScreenshots(deviceSerial);
	const runningConfig = RunningConfigObjects.getDevice(deviceSerial);
	if (_.isObject(runningConfig) === false) {
		res.status(500).json({
			error: 'Tried to record a video on invalid android serial',
			config: runningConfig,
			serial: deviceSerial
		});
	}
	debug(runningConfig);
	const totalFrameCount = runningConfig.screenshotFrameCount;
	let realTimeDuration = moment().unix() - runningConfig.screenRecordStartTime;
	let compressedTime = _.round(realTimeDuration * 0.2);
	debug('Total frameRatecount for device: ' + deviceSerial + ' is: ' + totalFrameCount +
		' realTimeDuration is: ' + realTimeDuration + ' and compressedTime is: ' + compressedTime);
	return ffmpeg
		.createVideoFromFramesSave('%05d.jpg', screenshotDir, path.resolve('tmp', deviceSerial + '.mp4'), videoOptions)
		.then((output) => {
			debug(output);
			let videoStream = fs.createReadStream(output);
			videoStream.pipe(res);
			debug('Trying to close socket Server for : ' + deviceSerial);
			return screencap.closeSocketServer(WebSocketServerObject[deviceSerial]);
		})
		.catch((error) => {
			console.error('android-video error: ' + error);
			res.status(500).json({message: 'getting video recording failed', error: error.message, stack: error.stack});
		});
});


app.get('/end-logcat', function (req, res) {
	//TODO better way to end logcat and have an array of logcat objects
	logcatGlobal.end();
	res.send('closed');
});
