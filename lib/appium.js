/**
 * Created by jamie on 14/08/17.
 */
'use strict';

const _ = require('lodash');
const when = require('when');
const debug = require('debug')('automation:server:appium');
const appiumPath = require.resolve('appium');
const {spawn} = require('child_process');
const path = require('path');
const fs = require('fs');
const rp = require('request-promise');
const os = require('os');
const helpers = require('./helpers');

let TIMEOUT_LIMIT;
let TMP_DIR;
if (os.platform() === 'win32') {
	TIMEOUT_LIMIT = 25;
	TMP_DIR = path.resolve(os.homedir(), 'appiumTemp'); //TODO test this
} else {
	TIMEOUT_LIMIT = 100;
	TMP_DIR = '/tmp/appiumServer';
}

function checkServerStatus(host, port, timeoutCount) {
	const url = 'http://' + host + ':' + port + '/wd/hub/status';
	const options = {
		url: url,
		timeout: 30000
	};
	return rp(options)
		.catch((error) => {
			debug(`checkServerStatusError: ${error}`);
			timeoutCount += 1;
			if (timeoutCount > TIMEOUT_LIMIT) {
				throw new Error('timeoutCount limit reached');
			}
			return when().delay(1000).then(() => {
				return checkServerStatus(host, port, timeoutCount);
			});
		});
}

function killServersByPorts(serverList) {
	let cleanPromises = [];
	serverList.forEach((server) => {
		cleanPromises.push(helpers.doShellKillByPort(server.port));
	});
	return when.settle(cleanPromises);
}

function startAppiumServers(configOptions, serverList) {
	const extraLaunchArgs = configOptions.appiumServerBootConfig.extraLaunchOptions;
	const logDir = path.resolve(process.cwd(), configOptions.appiumServerBootConfig.logFileLocation);
	let serverPromises = [];
	serverList.forEach((server, index) => {
		const serverlogPath = path.join(logDir, `appiumServer${server.port}.log`);
		const bootStrapPort = (_.toInteger(configOptions.appiumServerBootConfig.bootStrapPortStart) + index).toString();
		const chromeDriverPort = (_.toInteger(configOptions.appiumServerBootConfig.chromeDriverPortStart) + index).toString();
		let appiumLaunchArgs = [
			appiumPath, '-a', server.host, '-p', server.port, '--tmp', TMP_DIR + server.port, '--log', serverlogPath,
			'--bootstrap-port', bootStrapPort, '--chromedriver-port', chromeDriverPort];
		if(configOptions.customChromeDriver){
			if(fs.existsSync(configOptions.customChromeDriver)){
				appiumLaunchArgs = appiumLaunchArgs.concat(['--chromedriver-executable', configOptions.customChromeDriver]);
			} else {
				console.warn(`customChromeDriverPath is set to ${configOptions.customChromeDriver} but is not a valid path, not setting....`);
			}
		}
		appiumLaunchArgs = appiumLaunchArgs.concat(extraLaunchArgs);
		//TODO errors occur on stdout.... handle this
		//const errorLog = fs.openSync(path.join(logDir, `appiumError${server.port}.log`), 'w');
		const spawnOptions = {
			detached: true,
			stdio: ['ignore', 'ignore', 'ignore']
		};
		let appiumProc = spawn(process.execPath, appiumLaunchArgs, spawnOptions);
		appiumProc.unref();
		debug(`Launched appium on pid:${appiumProc.pid} with ${appiumLaunchArgs}`);
		server.pid = appiumProc.pid;
		server.spawnargs = appiumProc.spawnargs;
		serverPromises.push(checkServerStatus(server.host, server.port, 0));
	});
	return when.all(serverPromises).then((results) => {
		debug(results);
		return serverList;
	});
}

module.exports.generateServerList = (configOptions) => {
	const startPort = configOptions.appiumServerPortStart;
	const appiumServerNum = configOptions.appiumServerCount;
	const appiumServerHost = configOptions.appiumServerHost;
	const defaultCaps = configOptions.appiumDefaultCaps;
	let serverList = [];
	for (let port = startPort; port < startPort + appiumServerNum; port++) {
		serverList.push(_.cloneDeep({ //calling clone because desired caps gets modified later on with merge
			host: appiumServerHost,
			port: port,
			desiredCaps: defaultCaps
		}));
	}
	if (configOptions.bootAppiumServers === true) {
		if (appiumServerNum > 10) {
			return when.reject(`Trying to boot too many appium servers ${appiumServerNum}`);
		}
		if (configOptions.appiumServerBootConfig.killAppiumPorts === true) {
			return killServersByPorts(serverList).delay(250)
				.then((results) => {
					debug(results);
					return startAppiumServers(configOptions, serverList);
				});
		} else {
			return startAppiumServers(configOptions, serverList);
		}
	} else {
		return when.resolve(serverList);
	}
};