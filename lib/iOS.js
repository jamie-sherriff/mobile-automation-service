/**
 * Created by jamie on 19/11/15.
 */
'use strict';
const os = require('os');
const _ = require('lodash');
const exec = require('child_process').exec;
const when = require('when');
const debug = require('debug')('automation:server:iOS');
const helpers = require('./helpers');
const xcode = require('appium-xcode');

var generateIosIpadEmulatorList = function (iosEmulatorIpadList) {
	var desiredCapsIpad = {
		platformName: 'iOS',
		platformVersion: '8.4',
		deviceName: 'iPad Retina',
		sendKeyStrategy: 'oneByOne',
		orientation: 'LANDSCAPE',
		launchTimeout: 180000,
		showIOSLog: false,
		nativeWebTap: true,
		app: null
	};
	iosEmulatorIpadList.push(desiredCapsIpad);
	return iosEmulatorIpadList;
};

var generateIosEmulatorList = function (iosEmulatorList) {
	var desiredCapsIphone = {
		platformName: 'iOS',
		platformVersion: '8.4',
		deviceName: 'iPhone 5',
		orientation: 'PORTRAIT',
		showIOSLog: false,
		sendKeyStrategy: 'oneByOne',
		launchTimeout: 180000,
		nativeWebTap: true,
		app: null
	};
	iosEmulatorList.push(desiredCapsIphone);
	return iosEmulatorList;
};

module.exports.getSimulatorDeviceType = (simulator) => {
    if (_.includes(simulator.deviceName, 'iPhone')) {
        return 'iPhone';
    } else {
        return 'iPad';
    }
};

const DEFAULT_IOS_CAPS = {
    automationName: 'XCUITest'
};

module.exports.DEFAULT_iOS_CAPS = DEFAULT_IOS_CAPS;

function addDeviceInfo(device) {
	const iDeviceInfoCmd = 'ideviceinfo -u ' + device.deviceSerial;
	return helpers
		.execSystemCommand(iDeviceInfoCmd, iDeviceInfoCmd)
		.then((cmdOutput) => {
			let iDeviceJson = {};
			const output = cmdOutput.stdout.trim().split('\n');
			output.forEach(function (line) {
				let splitLine = line.split(':');
				iDeviceJson[splitLine[0].trim()] = splitLine[1].trim();
			});
			//Appium defaults to portrait so dont care if phone
			if (iDeviceJson.DeviceClass === 'iPad') {
				debug('Found iPad so setting to landscape');
				device.desired.orientation = 'LANDSCAPE';
			}
			device.deviceType = iDeviceJson.ProductType;
			return device;
		})
		.catch((error) => {
			debug(`Not adding ${JSON.stringify(device)} to retreiveIosDeviceList because of error: ${error}`);
		});
}

module.exports.retreiveIosDeviceList = function (opts) {
	if (!opts) {
		return when.reject('Need to specify opts for retreiveIosDeviceList');
	}
	const iosPackageName = opts.iosPackageName;
	if (os.platform() !== 'darwin') {
		return when.resolve({'error': 'using incompatible os'});
	}
	const usbDevicesCmd = "system_profiler SPUSBDataType | sed -n -E -e '/(iPhone|iPad)/,/Serial/s/ *Serial Number: *(.+)/\\1/p'";
	const instrumentsCommand = 'instruments -s devices';
	debug('Running: ' + usbDevicesCmd);
	return helpers
		.execSystemCommand(usbDevicesCmd, 'system_profiler SPUSBDataType | sed', /error/, {timeout: 20000, killSignal: 'SIGTERM'})//TODO hardcoded global system sed
		.then((sysOutput) => {
			const deviceSerialsString = sysOutput.stdout.trim();
			const deviceSerials = deviceSerialsString.split('\n');
			if (deviceSerialsString.length < 1) {
				return when.resolve({'error': 'no usb devices connected', devices: deviceSerialsString});
			}
			debug('Running: ' + instrumentsCommand);
			return helpers
				.execSystemCommand(instrumentsCommand, 'instruments devices', /error/, {timeout: 20000, killSignal: 'SIGTERM'}) //Timeout bumped for xcode relocation errors
				.then((instrumentOutput) => {
					const instrumentsList = instrumentOutput.stdout.trim().split('\n');
					let localIosDevicelist = [];
					deviceSerials.forEach((serial) => {
						instrumentsList.forEach((instrument) => {
							if (_.includes(instrument, serial)) {
								var deviceName = instrument.split(' [')[0];
								if (deviceName.split('(')[1]) {
									const platformVersion = deviceName.split('(')[1].replace(')', '');
									const desiredCaps = {
										platformName: 'iOS',
										bundleId: iosPackageName,
										platformVersion: platformVersion,
										udid: serial,
										deviceName: deviceName,
										launchTimeout: 60000,
										app: null
									};
									const iosDeviceJson = {
										deviceName: deviceName,
										deviceSerial: serial,
										desired: desiredCaps,
										deviceType: null
									};
									localIosDevicelist.push(iosDeviceJson);
								}
							}
						});
					});
					return localIosDevicelist;
				})
				.then((iosDevicelist) => {
					return when.filter(iosDevicelist, addDeviceInfo);
				});
		});
};

function parseIosVerson(version) {
    //Sorry, Apple Magic as i don't get a nice sdkVersion that can be parsed
    return _.toNumber(version.substring(0, version.indexOf('.') + 1) + (version.substring(version.indexOf('.') + 1)).replace(/\./g, ''));
}

module.exports.retreiveXcodeInfo = function () {
    var xcodeJson = {xcodePath: null, xcodeVersion: null, maxIosSdk: null};
    return xcode
        .getVersion()
        .then((version) => {
            xcodeJson.xcodeVersion = version;
            let floatVersionString = version.substring(0, version.indexOf('.') + 1) + version.substring(version.indexOf('.') + 1).replace('.', '');
            xcodeJson.xCodeVersionNumber = _.toNumber(floatVersionString);
        })
        .then(xcode.getPath)
        .then((path) => {
            xcodeJson.xcodePath = path;
        })
        .then(xcode.getMaxIOSSDKWithoutRetry)
        .then((getMaxIosSDK) => {
            xcodeJson.maxIosSdk = getMaxIosSDK;
            return xcodeJson;
        })
        .catch((error) => {
            console.error(error);
            throw error;
        });
};

module.exports.shutdownSim = function (udid) {
    var shutdownCommand = 'xcrun simctl shutdown ' + udid;
    return helpers.execSystemCommand(shutdownCommand, 'simctl shutdown ' + udid, /error/);
};

module.exports.eraseSim = function (udid) {
    var eraseCommand = 'xcrun simctl erase ' + udid;
    return helpers.execSystemCommand(eraseCommand, 'simctl erase ' + udid, /error/);
};

module.exports.shutDownSimulators = function () {
    var simulatorProcessList = ['Simulator', 'iOS Simulator'];
    var execOptions = {
        timeout: 5000
    };
    var promises = [];
    simulatorProcessList.forEach((simulatorProcess) => {
        promises.push(when.promise(function (resolve, reject) {
            exec('osascript -e \'quit app "' + simulatorProcess + '"\'', execOptions, (error, stdout, stderr) => {
                if (error !== null) {
                    console.error(`exec error: ${error}`);
                    reject({processName: simulatorProcess, stdout: stdout, stderr: stderr, error: error});
                }
                resolve({processName: simulatorProcess, stdout: stdout, stderr: stderr});
            });
        }));
    });
    return when.settle(promises);
};

/*Alot of logic has been ported from the es6 module node-simtctl*/
module.exports.retreiveSimulatorList = function (configOptions) {
	return when.promise((resolve) => {
		var deviceList = {all: [], iphones: [], ipads: []};
		var execOptions = {
			timeout: 10000
		};
		exec('xcrun simctl list', execOptions, function (error, stdout, stderr) {
			if (error) {
				console.error('error found while doing xcrun simctl list');
				console.error(stderr);
				console.error(stdout);
				deviceList.error = error;
				resolve(deviceList);
				return;
			}
			var simctlList = stdout;
			var iosHeadingRegex = /-- iOS (.+) --(\n    .+)*/mg;
			var platformSplit = simctlList.match(iosHeadingRegex);
			platformSplit.forEach(function (platform) {
				var lineRegex = /^    ([^\(]+) \(([^\)]+)\) \(([^\)]+)\)/; //eslint-disable-line no-useless-escape
				var splitPlatform = platform.split('\n');
				var platformVersionRow = splitPlatform[0];
				var platformVersionRegex = /(.*-- iOS\s+)(.*)(\s+--.*)/;
				//var platformVersionRegex = /iOS(.*)--/;
				var platformVersion = platformVersionRow.match(platformVersionRegex)[2];
				//console.log(platformVersion)
				var splitPlatformDevices = splitPlatform.slice(1);
				splitPlatformDevices.forEach(function (deviceRow) {
					//might need || _.includes(deviceRow,'device type profile not found') === false
					if (_.includes(deviceRow, 'unavailable') === false && _.includes(deviceRow, 'Resizable') === false) {
						var lineMatch = deviceRow.match(lineRegex);
						deviceList.all.push({
							platformName: 'iOS',
							version: platformVersion,
							name: lineMatch[1],
							udid: lineMatch[2],
							state: lineMatch[3]
						});
						if (_.includes(lineMatch[1].toLowerCase(), 'ipad')) {
							deviceList.ipads.push({
								platformName: 'iOS',
								platformVersion: platformVersion,
								deviceName: lineMatch[1],
								orientation: 'LANDSCAPE',
								showIOSLog: false,
								sendKeyStrategy: 'oneByOne',
								launchTimeout: 180000,
								nativeWebTap: true,
								app: null
							});
						} else if (_.includes(lineMatch[1].toLowerCase(), 'iphone')) {
							deviceList.iphones.push({
								platformName: 'iOS',
								platformVersion: platformVersion,
								deviceName: lineMatch[1],
								orientation: 'PORTRAIT',
								showIOSLog: false,
								sendKeyStrategy: 'oneByOne',
								launchTimeout: 180000,
								nativeWebTap: true,
								app: null
							});
						} else {
							console.error('Found line match that is not a valid device name: ' + lineMatch);
						}
					}

				});
			});
			debug('Found ' + deviceList.all.length + ' ios Emulators');
			if (configOptions.iosSimulatorRetrieval === 'dynamic') {
				debug('using dynamic ios simulators');
				_.forEach(deviceList, function (list, key) {
					deviceList[key] = _.shuffle(list);
				});
				resolve(deviceList);

			} else {
				debug('using ' + configOptions.iosSimulatorRetrieval + ' ios simulators');
				deviceList.iphones.length = 0;
				deviceList.ipads.length = 0;
				deviceList.iphones = generateIosEmulatorList(deviceList.iphones);
				deviceList.ipads = generateIosIpadEmulatorList(deviceList.ipads);
				resolve(deviceList);
			}
			//console.log(deviceList)
		});
	});

};

module.exports.parseIosVerson = parseIosVerson;