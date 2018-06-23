/*jslint node: true*/
/** Created by jamie on 15/10/15.*/
'use strict';
var globalNconf = require('nconf'),
	_ = require('lodash'),
	os = require('os'),
	fs = require('fs-extra');
const debug = require('debug')('automation:server:test-setup');
var path = require('path');
function stringToBoolean(string) {
	if (typeof(string) === 'boolean') {
		return string;
	} else if (string === null) {
		return null;
	} else {
		switch (string.toLowerCase().trim()) {
			case 'true':
			case 'yes':
			case '1':
				return true;
			case 'false':
			case 'no':
			case '0':
			case null:
				return false;
			default:
				return Boolean(string);
		}
	}
}

/*  This function exists for the purpose of being able to set JSON objects via environment variables in teamcity which get fed in as
 *   strings. */
function parseJsonObject(stringOrObject) {
	switch (typeof stringOrObject) {
		default:
			throw new Error('parseJsonObject has invalid object of type: ' + typeof stringOrObject +
				' being: ' + JSON.stringify(stringOrObject));
		case 'object':
			return stringOrObject;
		case 'string':
			try {
				return JSON.parse(stringOrObject);
			} catch (error) {
				if (error instanceof SyntaxError) {
					throw new Error('parseJsonObject has invalid string of JSON object: ' + JSON.stringify(stringOrObject));
				}
			}
	}
}

//eslint-disable-next-line complexity
function processConfiguration(nconf) {
	var userCsvFile = nconf.get('userCsvFile'),
		userGroup = nconf.get('userGroup'),
		account = nconf.get('account'),
		appiumServerHost = nconf.get('appiumServerHost').toLowerCase(),
		appiumServerCount = _.parseInt(nconf.get('appiumServerCount')),
		appiumServerPortStart = _.parseInt(nconf.get('appiumServerPortStart')),
		deviceServerPort = _.parseInt(nconf.get('deviceServerPort')),
		iosPackageName = nconf.get('iosPackageName'),
		iosSimulatorRetrieval = nconf.get('iosSimulatorRetrieval').toLowerCase(),
		androidOnly = stringToBoolean(nconf.get('androidOnly')),
		androidTcpip = nconf.get('androidTcpip'),
		androidTcpipHost = nconf.get('androidTcpipHost'),
		androidTcpipDomain = nconf.get('androidTcpipDomain'),
		androidTcpipPort = _.parseInt(nconf.get('androidTcpipPort')),
		avdName = nconf.get('avdName'),
		avdLaunchOptions = nconf.get('avdLaunchOptions'),
		startAndroidEmulators = stringToBoolean(nconf.get('startAndroidEmulators')),
		avdJsonFile = nconf.get('avdJsonFile'),
		turnOffAvds = stringToBoolean(nconf.get('turnOffAvds')),
		avdTimeZone = nconf.get('avdTimeZone'),
		benchmarkDir = nconf.get('benchmarkDir'),
		acceptClientAvdName = stringToBoolean(nconf.get('acceptClientAvdName')),
		deleteKnownAvds = stringToBoolean(nconf.get('deleteKnownAvds')),
		cleanOnStartup = stringToBoolean(nconf.get('cleanOnStartup')),
		downloadSelenium = stringToBoolean(nconf.get('downloadSelenium')),
		maxAvdUpTime = _.parseInt(nconf.get('maxAvdUpTime')),
		benchmarkPollTime = _.parseInt(nconf.get('benchmarkPollTime')),
		adbTestPort = _.parseInt(process.env.ANDROID_ADB_SERVER_PORT) || 5037,
		screenshotDir = nconf.get('screenshotDir'),
		extraAVDArgs = parseJsonObject(nconf.get('extraAVDArgs')),
		bootAppiumServers = stringToBoolean(nconf.get('bootAppiumServers')),
		appiumDefaultCaps = parseJsonObject(nconf.get('appiumDefaultCaps')),
		appiumServerBootConfig = parseJsonObject(nconf.get('appiumServerBootConfig')),
		resetServerPort = stringToBoolean(nconf.get('resetServerPort')),
		customChromeDriverVersion = nconf.get('customChromeDriverVersion'),
		automationUtilitiesPath = nconf.get('automationUtilitiesPath'),
		customChromeDriver = stringToBoolean(nconf.get('customChromeDriver')),
		screenCapDelayMs = _.parseInt(nconf.get('screenCapDelayMs')),
		routeSimulationPollTimeMs = _.parseInt(nconf.get('routeSimulationPollTimeMs')),
		dontStopScreenCap = stringToBoolean(nconf.get('dontStopScreenCap')),
		screenCaptureTimeoutMins = _.parseInt(nconf.get('screenCaptureTimeoutMins')),
		seleniumDir = nconf.get('seleniumDir');

	benchmarkDir = path.join(process.cwd(), benchmarkDir);
	userCsvFile = path.resolve(__dirname, 'application_users', account, userGroup, userCsvFile);
	//dont stick with lowercase because of appium had a bug in converting and don't rely on it
	if (_.isString(androidOnly) === true && _.isBoolean(androidOnly) === false) {
		androidOnly = androidOnly.toLowerCase();
		if (androidOnly === 'false') {
			androidOnly = false;
		} else {
			androidOnly = true;
		}
	}
	if (appiumServerHost === 'localhost' || process.env.USE_LOCAL_HOST || appiumServerHost === 'default') {
		appiumServerHost = '127.0.0.1';
	} else if (appiumServerHost === 'hostname') {
		appiumServerHost = os.hostname();
	} else {
		console.log('Using AppiumServerHost untouched, assuming custom: ' + appiumServerHost);
	}
	debug('Using appiumServerHost: ' + appiumServerHost);

	if (_.isNil(customChromeDriverVersion) === false) {
		customChromeDriverVersion = _.toString(customChromeDriverVersion);
	}

	seleniumDir = path.resolve(seleniumDir);

	automationUtilitiesPath = automationUtilitiesPath.toLowerCase();
	switch (automationUtilitiesPath) {
		case 'default':
		case 'homedir':
			automationUtilitiesPath = path.resolve(os.homedir(), 'automation-utils');
			break;
		default:
			automationUtilitiesPath = path.resolve(automationUtilitiesPath);
	}
	debug(`automationUtilitiesPath set to ${automationUtilitiesPath}`);

	return {
		userCsvFile, userGroup, account, appiumServerCount,
		appiumServerHost, appiumServerPortStart, deviceServerPort,
		iosPackageName, iosSimulatorRetrieval, androidOnly,
		androidTcpip, androidTcpipHost, androidTcpipPort, androidTcpipDomain,
		startAndroidEmulators, avdName, avdJsonFile, avdLaunchOptions, turnOffAvds, avdTimeZone, maxAvdUpTime,
		adbTestPort, acceptClientAvdName, deleteKnownAvds, benchmarkDir, benchmarkPollTime, screenshotDir,
		cleanOnStartup, seleniumDir, downloadSelenium, extraAVDArgs, bootAppiumServers, appiumServerBootConfig,
		resetServerPort, customChromeDriverVersion, customChromeDriver, screenCapDelayMs, dontStopScreenCap,
		screenCaptureTimeoutMins, routeSimulationPollTimeMs, appiumDefaultCaps
	};
}
globalNconf.argv()
	.env()
	.file({file: './serverConfig.json'});
var configOptions = processConfiguration(globalNconf);
module.exports.configOptions = configOptions;
//(configOptions); = configOptions;


module.exports.GetJsonUserList = function (csvFile) {
	return fs.readFile(csvFile, 'utf8').then((data) => {
		let jsonList = [];
		let csvArray = null;
		if (_.includes(data, '\r')) {
			csvArray = data.trim().split('\r\n');
		} else {
			csvArray = data.trim().split('\n');
		}
		let splitHeaders = csvArray[0].split(',');
		let content = csvArray.slice(1);
		splitHeaders = _.map(splitHeaders, _.trim);
		content.forEach((row) => {
			let splitRow = row.split(',');
			splitRow = _.map(splitRow, _.trim);
			let jsonData = {};
			if (splitRow.length !== splitHeaders.length) {
				throw new Error('Header length does not much item row');
			} else {
				splitRow.forEach((item, itemIndex) => {
					let headerItem = splitHeaders[itemIndex];
					jsonData[headerItem] = item;
				});
			}
			jsonList.push(jsonData);
		});
		return _.shuffle(jsonList);
	});
};


//TODO be more efficent and use _.every and abort and handle same udids with an error
module.exports.getSimulatorUdid = function (simulatorList, name, version) {
	debug('finding udid match for: ' + name, version);
	var udid = null;
	simulatorList.forEach(function (simulator) {
		//console.log(simulator);
		if (simulator.name.toLowerCase() === name.toLowerCase() && simulator.version === version) {
			udid = simulator.udid;
			debug('Found matching udid: ' + udid + ' For ' + name + ' ' + version);
		}
	});
	return udid;
};
