/**
 * Created by jamie on 19/11/15.
 */
'use strict';
/* jshint proto: true */

var async = require('async');
var debug = require('debug')('automation:server:android');
var _ = require('lodash');
var adb = require('adbkit');
var emulator = require('./android-emulator');
var path = require('path');
var when = require('when');
var helpers = require('./helpers');
var which = require('which');
var emulatorConfigFilePath = (path.join(__dirname, '..', 'android-emulators.json'));
var emulatorJson = require(emulatorConfigFilePath);
const DEFAULT_ANDROID_CAPS = {
	appWaitDuration: 30000,
	disableAndroidWatchers: true,
	nativeWebScreenshot: true,
	recreateChromeDriverSessions: true

};
const selenium = require('selenium-standalone');
const glob = require('glob');
const ini = require('ini');
const fs = require('fs-extra');

//TODO get application pid `adb shell ps | grep <your com. application name> | awk '{ print $2 }'`


function checkIfAndroidEmulator(deviceSerial, properties) {
	var manufacturer = null;
	if (properties['ro.product.manufacturer']) {
		manufacturer = (properties['ro.product.manufacturer']).toLowerCase();
	} else {
		manufacturer = 'Unknown';
		console.warn('found device: ' + deviceSerial + 'with no manufacturer');
		console.warn(properties);
	}

	//Dont use ':' to check incase devices are tcpip connected
	if (_.includes(manufacturer, 'genymotion') || _.includes(manufacturer, 'xamarin') || _.includes(deviceSerial.toLowerCase(), 'emulator')) {
		debug('Found emulator with serial: ' + deviceSerial);
		return true;
	} else {
		return false;
	}
}

function filterOutBadDevices(deviceList) {
	deviceList.forEach(function (device) {
		if (device.type === 'unauthorized' || device.type === 'offline') {
			debug('found unauthorized|offline device so removing it which is: ' + JSON.stringify(device));
			_.remove(deviceList, {
				id: device.id
			});
		}
	});
	return deviceList;
}

module.exports.checkAndroidDeviceIsValid = function (client, deviceList) {
	return when.promise((resolve, reject) => {
		deviceList = filterOutBadDevices(deviceList);
		var androids = {deviceList: [], emulatorList: []};
		async.forEachOf(deviceList, function (device, key, callback) {
			client
				.getProperties(device.id)
				.then(function (properties) {
					var sdkVersion = parseInt(properties['ro.build.version.sdk']);
					if (sdkVersion < 19) {
						debug('Found device ' + key + ' at api level: ' + sdkVersion.toString() + ' discarding ' + device.id.toString());
						_.remove(deviceList, {
							id: device.id
						});
					}
					if (checkIfAndroidEmulator(device.id, properties)) {
						device.type = 'emulator'; //adbkit only recognises stock emulators
						androids.emulatorList.push(device);
						_.remove(deviceList, {
							id: device.id
						});
					}
					callback();
				});
		}, function (err) {
			if (err) {
				reject(err);
			}
			androids.deviceList = deviceList;
			resolve(androids);
		});
	});
};

module.exports.returnFilteredDeviceProperties = function (androidProperties) {
	var wantedPropertiesList = ['ro.product.manufacturer', 'ro.product.model', 'ro.product.name',
		'ro.com.android.dateformat', 'ro.build.version.sdk', 'ro.build.version.release', 'persist.sys.timezone',
		'bluetooth.status', 'ro.boot.serialno', 'net.hostname', 'dhcp.wlan0.dns1', 'dhcp.wlan0.domain',
		'dhcp.wlan0.gateway', 'dhcp.wlan0.ipaddress', 'dhcp.wlan0.leasetime', 'dhcp.wlan0.result',
		'ro.build.characteristics', 'persist.sys.timezone'];
	var filteredProperties = {};
	_.forEach(androidProperties, function (propertyValue, propertyKey) {
		_.forEach(wantedPropertiesList, function (wantedKey) {
			if (wantedKey === propertyKey) {
				filteredProperties[propertyKey] = propertyValue;
			}
		});
	});
	return filteredProperties;
};

var returnFilteredDeviceProperties = function (androidProperties) {
	var wantedPropertiesList = ['ro.product.manufacturer', 'ro.product.model', 'ro.product.name',
		'ro.com.android.dateformat', 'ro.build.version.sdk', 'ro.build.version.release', 'persist.sys.timezone',
		'bluetooth.status', 'ro.boot.serialno', 'net.hostname', 'dhcp.wlan0.dns1', 'dhcp.wlan0.domain',
		'dhcp.wlan0.gateway', 'dhcp.wlan0.ipaddress', 'dhcp.wlan0.leasetime', 'dhcp.wlan0.result',
		'ro.build.characteristics', 'persist.sys.timezone'];
	var filteredProperties = {};
	_.forEach(androidProperties, function (propertyValue, propertyKey) {
		_.forEach(wantedPropertiesList, function (wantedKey) {
			if (wantedKey === propertyKey) {
				filteredProperties[propertyKey] = propertyValue;
			}
		});
	});
	return filteredProperties;
};

module.exports.checkTcpipConnection = function (client, configOptions) {
	if (configOptions.androidTcpip) {
		var host = configOptions.androidTcpipHost;
		var domain = configOptions.androidTcpipDomain;
		var port = configOptions.androidTcpipPort;
		var connectionString = host + domain;
		debug('Trying tcpip connect for: ' + connectionString);
		return client
			.connect(connectionString, port)
			.then(function (id) {
				// It can take a moment for the connection to happen.
				debug('reconnected by tcpip to: ' + id);
				return client.waitForDevice(id);
			})
			.catch(function (err) {
				console.error('something went wrong trying to tcpip connect', err.stack);
				return client;
			});
	} else {
		return client;
	}
};

module.exports.trackAndroidDevices = function (client, configOptions) {
	return client
		.trackDevices()
		.then(function (tracker) {
			tracker.on('add', function (device) {
				debug('Device %s was plugged in', device.id);
				if (configOptions.androidTcpip) {
					return client
						.listForwards(device.id)
						.then(function (forwards) {
							debug('forwards length: ' + forwards.length.toString());
							debug('list of forwarded ports for reconnect: ' + JSON.stringify(forwards));
							if (configOptions.androidTcpip && forwards.length === 0) {
								return client
									.forward(device.id, 'tcp:4700', 'tcp:4724')
									.then(function () {
										debug('forwarded adb on "%s"', device.id);
									});
							}
						})
						.catch(function (err) {
							console.error('something went wrong trying to tcpip connect', err.stack);
						});
				}
			});
			tracker.on('change', function (device) {
				debug('Device %s was changed ', device.id);
			});
			tracker.on('remove', function (device) {
				debug('Device %s was unplugged', device.id);
				if (configOptions.androidTcpip) {
					var host = configOptions.androidTcpipHost;
					var domain = configOptions.androidTcpipDomain;
					var port = configOptions.androidTcpipPort;
					var connectionString = host + domain;
					debug('Trying to reconnect tcpip for: ' + connectionString);
					return client
						.connect(connectionString, port)
						.then(function (id) {
							return client
								.getState(id)
								.then(function (state) {
									debug('found device %s in state ' + state, id);
									return id;
								});
						})
						.then(function (id) {
							// It can take a moment for the connection to happen.
							debug('reconnected by tcpip to: ' + id);
							return client.waitForDevice(id);
						})
						.then(function (id) {
							return client
								.forward(id, 'tcp:4700', 'tcp:4724')
								.then(function () {
									debug('forwarded adb on "%s"', id);
								});
						})
						.catch(function (err) {
							console.error('something went wrong trying to tcpip connect', err.stack);
						});
				}
			});
			tracker.on('end', function () {
				debug('Tracking stopped');

			});
		})
		.catch(function (err) {
			console.error('Something went wrong:', err.stack);
		});
};

/* Alternative method to clearing logcat
 //.openLogcat(device.id, {clear: true})
 //.then(function (logcatClient) {
 //    console.log('Cleared logcat');
 //    //console.log(logcatClient);
 //    logcatClient.end();
 //    return client;
 //})
 */
module.exports.clearLogCat = function (adbClient, deviceId) {
	return adbClient
		.shell(deviceId, 'logcat -c')
		.then(adb.util.readAll)
		.then(function (output) {
			debug('[%s] %s', deviceId, output.toString().trim());
			debug({status: 'Clearing Logcat success for ' + deviceId, output: output.toString().trim()});
			return adbClient;
		})
		.catch(function (err) {
			console.error('Something went with clearing logcat wrong:', err.stack);
			return adbClient;
		});
};

var clearLogCat = function (adbClient, deviceId) {
	return adbClient
		.shell(deviceId, 'logcat -c')
		.then(adb.util.readAll)
		.then(function (output) {
			debug('[%s] %s', deviceId, output.toString().trim());
			debug({status: 'Clearing Logcat success for ' + deviceId, output: output.toString().trim()});
			return adbClient;
		})
		.catch(function (err) {
			console.error('Something went with clearing logcat wrong:', err.stack);
			return adbClient;
		});
};

var createStartAndroidEmulator = function (avdName, configOptions) {
	// var emulatorName = null;
	// if (requestArgs.customAvdName && configOptions.acceptClientAvdName) {
	//     debug('Found customAvdName for creation so using: ' + requestArgs.customAvdName);
	//     emulatorName = requestArgs.customAvdName;
	// } else {
	//     emulatorName = configOptions.avdName;
	// }
	var emulatorCreateOptions = emulatorJson[avdName].options;
	var emulatorhardwareOptions = emulatorJson[avdName].hardware;
	var emulatorLaunchOptions = null;
	if (typeof configOptions.avdLaunchOptions === 'string') {
		emulatorLaunchOptions = configOptions.avdLaunchOptions;
	} else {
		emulatorLaunchOptions = emulatorJson[avdName].launchOptions;
	}
	if (configOptions.extraAVDArgs.enabled === true) {
		emulatorLaunchOptions += ' ' + configOptions.extraAVDArgs.args;
	}
	debug('emulatorLaunchOptions with: ' + JSON.stringify(emulatorLaunchOptions));
	return emulator
		.create(avdName, emulatorCreateOptions)
		.then(() => {
			return emulator.list();
		})
		.then(function (emulatorList) {
			return emulator.setHardwareOptions(avdName, emulatorList, emulatorhardwareOptions);
		})
		.then(function (result) {
			debug(result);
		})
		.then(function () {
			return emulator.start(avdName, emulatorLaunchOptions);
		});
};

var startAndroidEmulator = function (configOptions, requestArgs) {
	var emulatorName = null;
	if (requestArgs.customAvdName && configOptions.acceptClientAvdName) {
		debug('Found customAvdName for stating so using: ' + requestArgs.customAvdName);
		emulatorName = requestArgs.customAvdName;
	} else {
		emulatorName = configOptions.avdName;
	}
	var emulatorInstance = {port: null, id: null, type: null};
	var emulatorhardwareOptions = emulatorJson[emulatorName].hardware;
	var emulatorLaunchOptions = null;
	if (typeof configOptions.avdLaunchOptions === 'string') {
		emulatorLaunchOptions = configOptions.avdLaunchOptions;
	} else {
		emulatorLaunchOptions = emulatorJson[emulatorName].launchOptions;
	}
	//var emulatorCreateOptions = emulatorJson[emulatorName].options; //TODO should use this?
	if (configOptions.extraAVDArgs.enabled === true) {
		emulatorLaunchOptions += ' ' + configOptions.extraAVDArgs.args;
	}
	debug('emulatorLaunchOptions with: ' + JSON.stringify(emulatorLaunchOptions));
	return emulator
		.list()
		.then(function (emulatorList) {
			var emulatorIndex = null;
			emulatorList.forEach(function (emu, index) {
				if (_.includes(emu.Name, emulatorName)) {
					emulatorIndex = index;
					debug('Found default appium emulator: ' + emulatorName);
				}
			});
			debug('emulator: ' + JSON.stringify(emulatorList[emulatorIndex]));
			if (emulatorList[emulatorIndex]) {
				return emulator
					.setHardwareOptions(emulatorList[emulatorIndex].Name, emulatorList, emulatorhardwareOptions)
					.then((result) => {
						debug(result);
						return emulator.start(emulatorList[emulatorIndex].Name, emulatorLaunchOptions);
					});
			} else {
				debug('fail to find emulator so creating and starting a new one');
				return createStartAndroidEmulator(emulatorName, configOptions);
				// return new Error('Need to create emulator');
			}
		})
		.then(function (startedEmulator) {
			emulatorInstance = startedEmulator;
			var extendedTime = Math.min((parseInt(startedEmulator.bootAttempts / 10) * 1000), 20000);
			return emulator.sleep(5000 + extendedTime);
		})
		.then(() => {
			return emulator.enableLocation(emulatorInstance);

		})
		.then(() => {
			return emulator.setLocation('172.54539', '-43.48948', '20', '10', emulatorInstance.port);
		})
		.then(() => { //bug in android api 19 avd images dont set timezone launch flag.
			return emulator.setTimeZone({port: emulatorInstance.port}, configOptions.avdTimeZone);
		})
		.then(() => {
			return emulator.setNetwork('full', emulatorInstance.port);
		})
		.then(() => {
			return emulator.showScreenMovement(emulatorInstance);
		})
		.then(() => {
			return emulatorInstance;
		})
		.catch(function (emulatorError) {
			debug(emulatorError);
			debug('problem starting emulator so attempting to stop');
			return emulator
				.stop(emulatorError)
				.then(() => {
					throw new Error('problem starting android emulator but shutdown: ');
				})
				.catch((subError) => {
					debug(subError);
					if (emulatorError.message) {
						throw new Error('problem starting and stopping android emulator: ' + emulatorError.message);
					} else {
						throw new Error('problem starting and stopping android emulator: ' + JSON.stringify(emulatorError));
					}
				});
		});
};

function mapAndroidApiToChromeDriver(sdkVersion) {
	const versionObject = {
		19: '2.8',
		22: '2.14',
		23: '2.20',
		24: '2.23',
	};
	return versionObject[sdkVersion] || null;
}

function downloadChromeDriver(chromeDriverVersion, seleniumPath) {
	debug(`Downloading chromeDriverVersion: ${chromeDriverVersion} to path: ${seleniumPath}`);
	return when.promise((resolve, reject) => {
		selenium.install({
			version: null,
			baseURL: null,
			drivers: {
				chrome: {
					version: chromeDriverVersion,
					arch: process.arch,
					baseURL: 'https://chromedriver.storage.googleapis.com'
				}
			},
			basePath: seleniumPath,
			logger: (message) => {
				debug(message);
			}
		}, (error) => {
			if (error) {
				reject(error);
			} else {
				debug('Selenium and chrome downloaded');
				glob(`**/*${chromeDriverVersion}*`, {cwd: seleniumPath, ignore: '**/*.zip'}, (globError, matches) => {
					if (globError) {
						reject(new Error(globError));
					}
					else if (matches.length > 1) {
						reject(new Error('Too many chromedrivers found: ' + matches));
					} else {
						resolve(path.resolve(seleniumPath, matches[0]));
					}
				});
			}
		});
	});

}


let downloadChromeDriverForAndroidVersion = (sdkVersion, configOptions) => {
	const seleniumPath = configOptions.seleniumDir;
	const custom = configOptions.customChromeDriverVersion;
	let chromeDriverVersion;
	if (custom) {
		if (custom.length >= 3) {
			debug(`Using custom chromeDriverVersion of: ${custom}`);
			chromeDriverVersion = _.toString(custom);
		}
	} else {
		chromeDriverVersion = mapAndroidApiToChromeDriver(sdkVersion);
	}
	if (_.isNil(chromeDriverVersion)) {
		return when.reject(new Error('Invalid sdkversion specified: ' + sdkVersion));
	}
	return downloadChromeDriver(chromeDriverVersion, seleniumPath);
};

let getChromeDriver = (properties, configOptions) => {
	let sdkVersion = parseInt(properties['ro.build.version.sdk']);
	if (configOptions.downloadSelenium === false) {
		debug('downloadSelenium is set to false so skipping download');
		return when.resolve({properties});
	}
	return downloadChromeDriverForAndroidVersion(sdkVersion, configOptions)
		.then((chromeDriverPath) => {
			debug('Returning chromedriver at: ' + chromeDriverPath);
			return {properties, chromeDriverPath};
		})
		.catch((error) => {
			debug('Something went wrong with downloadChromeDriverForAndroidVersion: ' + error);
			console.error('WEBVIEW tests will fail but continuing..');
			return {properties};
		});
};

let openAndroidFilePromise = (filePath) => {
	return fs
		.readFile(filePath, {encoding: 'utf8'})
		.then((data) => {
			return {name: filePath, data: data};
		});
};

let parseAndroidDataToJson = (fileData) => {
	let iniData = ini.parse(fileData.data);
	return {fileName: fileData.name, data: iniData};
};


//ONLY works on default android avds no Genymotion etc
let getAvdPortfromName = (name) => {
	const portRegex = new RegExp('-\\d{4,6}$');
	return _.toInteger((portRegex.exec(name)[0]).replace('-', ''));
};

function isStockAvd(device, properties) {
	return (properties['ro.product.model'].toLowerCase().includes('android sdk') && device.type === 'emulator');
}

var sendAndroidToClient = function (opts, res, configOptions) {
	var client = opts.client;
	var appiumServer = opts.appiumServer;
	var applicationUser = opts.applicationUser;
	var device = opts.device;
	var adbTestPort = opts.adbTestPort;
	var inUseDeviceList = opts.inUseDeviceList;
	if (!device || !applicationUser || !appiumServer) { //TODO need better error handling
		console.error('problem getting the required device information');
		return when.reject(new Error('problem getting the required device information: ' + JSON.stringify(opts)));
	}
	return clearLogCat(client, device.id)
		.then(() => {
			return client
				.getProperties(device.id)
				.then((properties) => {
					return getChromeDriver(properties, configOptions);
				})
				.then((info) => {
					let properties = info.properties;
					var desiredCaps = {
						platformName: 'Android',
						noReset: true,
						adbPort: adbTestPort,
						platformVersion: properties['ro.build.version.release'],
						deviceName: properties['ro.product.model'],
						udid: device.id,
						//udid: properties["ro.boot.serialno"], rooted/cfw devices dont match device.id
						app: null // will be set later
					};
					if (_.isUndefined(info.chromeDriverPath) === false) {
						desiredCaps.chromedriverExecutable = info.chromeDriverPath;
					}
					var defaultCaps = _.defaults(_.clone(appiumServer.desiredCaps), _.clone(DEFAULT_ANDROID_CAPS));
					appiumServer.desiredCaps = _.merge(defaultCaps, desiredCaps);
					var androidJson = {
						applicationUser: applicationUser,
						appium: appiumServer,
						serial: device.id,
						type: device.type,
						properties: returnFilteredDeviceProperties(properties),
						deviceName: properties['ro.product.model'],
						deviceType: properties['ro.build.characteristics'],
						sdkVersion: parseInt(properties['ro.build.version.sdk']),
						testPlatform: 'Android',
						testPlatformName: 'Android-emu-' + desiredCaps.platformVersion + '-' + desiredCaps.deviceName
					};
					if (isStockAvd(device, properties)) {
						androidJson.port = getAvdPortfromName(device.id);
					}
					debug(device);
					inUseDeviceList.push(androidJson);
					debug('sent ' + device.type + ' to test for android');
					res.json(androidJson);
					return inUseDeviceList;
				})
				.catch(function (err) {
					console.error('Something went wrong getting device or emulator information :', err.stack);
					res.status(500).json({error: err.message});
					throw new Error(err.message);
				});
		});
};

let getAndroidSDKVersionFiles = () => {
	const androidHomePath = helpers.getAndroidHome();
	return when.promise((resolve, reject) => {
		glob('**/*source.properties', {cwd: androidHomePath, absolute: true}, (error, files) => {
			if (error) {
				reject(files);
			} else {
				return resolve(files);
			}
		});
	});
};

//eslint-disable-next-line max-params
module.exports.startAndSendAndroidEmulatorToClient = function (configOptions, client, applicationUserList, requestArgs, appiumServerList, inUseDeviceList, res) {
	var module = this;
	//var updatedInUseDeviceList = [];
	return startAndroidEmulator(configOptions, requestArgs)
		.then((emulatorInstance) => {
			debug('started emulator: ' + JSON.stringify(emulatorInstance));
			return client
				.listDevices()
				.then(function (devices) {
					return module
						.checkAndroidDeviceIsValid(client, devices)
						.then((androids) => {
							debug(androids);
							var androidEmulatorList = androids.emulatorList;
							//TODO lol... doesn't check booted device is actully the one being sent
							var retreivedEmulator = androidEmulatorList.pop();
							var appiumServer = appiumServerList.shift();
							var applicationUser = helpers.getApplicationUser(applicationUserList, requestArgs);
							var reqOptions = {
								client: client,
								appiumServer: appiumServer,
								applicationUser: applicationUser,
								device: retreivedEmulator,
								inUseDeviceList: inUseDeviceList,
								adbTestPort: configOptions.adbTestPort
							};
							return sendAndroidToClient(reqOptions, res, configOptions);
						});
				});
		})
		.catch(function (error) {
			console.error('error startAndSendAndroidEmulatorToClient:');
			console.error(error);
			res.status(500).json({error: error.message, message: 'startAndSendAndroidEmulatorToClient error'});
			throw new Error(error);
		});
};

module.exports.shutDownAllAvds = function () {
	//TODO hardcoded madness should be configurable
	let killCommand1, killCommand2 = null;
	if (helpers.isWindows() === true) {
		//tasklist /FO CSV | findstr qemu
		//taskkill /pid 12024 /f
		// powershell -command "Stop-Process -Force -Name *qemu-system*"
		const stopProcessCMD = 'powershell -command "Stop-Process'; //Assume on Path as powershell built in
		killCommand1 = stopProcessCMD + ' -Force -Name *qemu-system*"';
		killCommand2 = stopProcessCMD + ' -Force -Name *emulator64*"';
	} else {
		const PKILL_CMD = which.sync('pkill');
		killCommand1 = PKILL_CMD + ' -9 qemu-system';
		killCommand2 = PKILL_CMD + ' -9 emulator64';
	}

	return when.settle([
		helpers.execSystemCommand(killCommand1, 'shutDownAllAvds killCommand1', /error/),
		helpers.execSystemCommand(killCommand2, 'shutDownAllAvds killCommand2', /error/)
	]);
};

module.exports.getReplacementEmulator = function (desiredCaps, adbClient, configOptions) {
	return startAndroidEmulator(configOptions, {})
		.then((emulatorInstance) => {
			debug('started emulator: ' + JSON.stringify(emulatorInstance));
			return adbClient
				.getProperties(emulatorInstance.id)
				.then((properties) => {
					desiredCaps.platformVersion = properties['ro.build.version.release'];
					desiredCaps.deviceName = properties['ro.product.model'];
					desiredCaps.udid = emulatorInstance.id;
					return desiredCaps;
				});
		})
		.catch((error) => {
			debug('Problem starting AndroidEmulator in getReplacementEmulator: ' + error);
			throw new Error('Problem starting AndroidEmulator in getReplacementEmulator: ' + error);
		});
};

module.exports.checkAndroidEmulatorPort = (port, host) => {
	debug(`checkAndroidEmulatorPort for port: ${port}`);
	return helpers.sendAndroidTelnetCommand('ping', port, host);
};

module.exports.restartAdb = (adbClient) => {
	return adbClient
		.listDevices()
		.then((devices) => {
			debug('device list before clearing: ' + JSON.stringify(devices));
		})
		.then(() => {
			try {
				return adbClient.kill();
			} catch (error) {
				console.error('AdbClient kill error:' + error);
			}
		})
		.then(() => {
			return adbClient
				.listDevices()
				.then((devices) => {
					debug('device list after clearing: ' + JSON.stringify(devices));
				});
		})
		.catch((error) => {
			debug('problem trying to restartAdb: ' + error);
		});
};

/*Hacked to keep the error listener listening so the promise can reject after a connection has been establish
 * Example error being ECONNRESET can occur after the connection is established. Example error below:
 *  adb:connection adb E 90487 14577833 usb_osx.cpp:327] Could not open interface: e00002c5
 adb:connection adb E 90487 14577833 usb_osx.cpp:289] Could not find device interface
 adb:connection error: could not install *smartsocket* listener: Address already in use
 adb:connection ADB server didn't ACK
 adb:connection * failed to start daemon *
 adb:connection error: cannot connect to daemon
 */
module.exports.modifyAdbClient = (adbClient) => {
	//Hack import start to modify adbkit proto
	const bluebird = require('bluebird'); //assume inheritance of adbkit
	const adbConnection = require('adbkit/lib/adb/connection');
	//Hack import end
	adbClient.__proto__.connection = function () {
		let conn, resolver;
		resolver = bluebird.defer();
		conn = new adbConnection(this.options)
			.on('error', function (err) {
				return resolver.reject(err);
			}).on('connect', function () {
				return resolver.resolve(conn);
			}).connect();
		return resolver.promise['finally'](function () {
			return conn;
		});
	};
	return adbClient;
};


module.exports.getAndroidVersionData = () => {
	return getAndroidSDKVersionFiles()
		.then((files) => {
			let promises = files.map(openAndroidFilePromise);
			return when
				.all(promises)
				.then((result) => {
					const versionJson = result.map(parseAndroidDataToJson);
					debug(versionJson);
					return versionJson;
				});
		});
};

module.exports.DEFAULT_ANDROID_CAPS = DEFAULT_ANDROID_CAPS;
module.exports.androidDeviceNotFoundRegex = new RegExp('\\bdevice\\b.*\\bnot found\\b', 'i');

module.exports.runningTimeReached = function (device, configOptions) {
	return emulator.runningTime(device)
		.then((runningTime) => {
			debug('running time is: ' + runningTime);
			return runningTime >= configOptions.maxAvdUpTime;
		});
};

module.exports.restartAndroid = function (device, configOptions) {
	debug('device is: ' + JSON.stringify(device));
	return emulator
		.stop(device)
		.then(() => {
			return startAndroidEmulator(configOptions, {});
		});
};

module.exports.downloadChromeDriverForAndroidVersion = downloadChromeDriverForAndroidVersion;
module.exports.getChromeDriver = getChromeDriver;
module.exports.getAndroidSDKVersionFiles = getAndroidSDKVersionFiles;
module.exports.getAvdPortfromName = getAvdPortfromName;
module.exports.isStockAvd = isStockAvd;
