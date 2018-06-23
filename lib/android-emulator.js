/**
 * Created by jamie on 19/11/15.
 * Code source taken from https://github.com/revolunet/node-android-emulator and modified
 */

//TODO
/*
 3. Wait for emulator to go to “device” state.
 4. Wait for property “dev.bootcompleted” to be set to 1.
 5. Wait for property “sys_bootcomplete” to be set to 1.
 6. Wait for “init.svc.bootanim” to be set to “stopped”.
 */

'use strict';
var which = require('which');
var fs = require('fs-extra'),
	path = require('path'),
	net = require('net'),
	shell = require('shelljs'),
	ini = require('ini'),
	spawn = require('child_process').spawn,
	os = require('os'),
	_ = require('lodash'),
	when = require('when'),
	Q = require('q');

const helpers = require('./helpers');
const debug = require('debug')('automation:server:android-emulator');
const debugSpawn = require('debug')('automation:server:android-emulator-spawn');
const debugTrace = require('debug')('automation-trace:server:android-emulator');

// Don't care if this blocks as emulators will fail to boot if there is no auth.
const USER_HOME_DIR = os.homedir();
const ANDROID_EMULATOR_AUTH_PATH = path.join(USER_HOME_DIR, '.emulator_console_auth_token');
debug('setting empty android emulator auth file at: ' + ANDROID_EMULATOR_AUTH_PATH);
fs.writeFileSync(ANDROID_EMULATOR_AUTH_PATH, '', 'utf8'); //TODO move into function with async
const ANDROID_AVD_USER_DIR = path.join(USER_HOME_DIR, '.android', 'avd');

//Google only allows "-port must be followed by an even integer number between 5554 and 5680"
const Tail = require('tail').Tail;
const tailOptions = {fromBeginning: false};
const EMUALTOR_POLL_LIMIT = 180;
const EMULATOR_START_TIMEOUT_MS = 200 * 1000;
const START_PORT_RNAGE = 5554;
const END_PORT_RANGE = 5580;
const androidHomePath = helpers.getAndroidHome();
const SDCARD_CMD = path.join(androidHomePath, 'tools', 'mksdcard');
try {
	var ECHO_CMD = which.sync('echo');
} catch (error) {
	ECHO_CMD = 'echo'; //Windows
}

let ADB_CMD = path.join(androidHomePath, 'platform-tools', 'adb');
const ADB_SERVER_PORT = process.env.ANDROID_ADB_SERVER_PORT || 5037;
if (ADB_SERVER_PORT !== 5037) {
	ADB_CMD += ' -P ' + ADB_SERVER_PORT.toString();
}
debug('adb command is: ' + ADB_CMD);
const EMULATOR_CMD = path.join(androidHomePath, 'tools', 'emulator');
const AVD_MANAGER_CMD = path.join(androidHomePath, 'tools', 'bin', 'avdmanager');


function startTailOnLogs(logFile, port, promise) {
	var tail;
	try {
		tail = new Tail(logFile, tailOptions);
	} catch (error) {
		console.error('error occured with startTailOnLogs: ' + error);
		return;
	}
	setTimeout(() => {
		if (tail) {
			if(tail.isWatching === true){
				debug(`un watching tail`);
				tail.unwatch();
			}
		}
	}, EMULATOR_START_TIMEOUT_MS);

	debug('starting tail on : ' + logFile);
	tail.on('line', function (data) {
		debugSpawn(data);
		const failRegex = new RegExp('(is not working|ERROR|invalid option|fatal|Failed to get HAX capability|VCPU shutdown request|' +
			'Unknown hax|The memory needed by this VM exceeds the driver limit|PANIC|invalid command-line parameter)');
		const ignoreRegex = new RegExp('(Unknown camera factory query name)');
		if (ignoreRegex.test(data) === true) {
			debug(`Found ignore regex match on line so ignoring it: ${data}`);
		} else if (failRegex.test(data) === true) {
			tail.unwatch();
			promise.reject({
				id: null,
				type: null,
				port: port,
				logMessage: data,
				error: 'found error in log output for: ' + logFile
			});
		}
	});

	tail.on('error', function (error) {
		console.error('AVD ERROR: ', error);
		tail.unwatch();
		promise.reject(new Error(`tail log error: ${error}`));
	});
}


var processKeyValueGroups = function (str) {
	var lines = str.split('\n');
	var currentKey = {};
	var results = [];
	lines.forEach(function (line) {
		var matches = line.match(/([\w/]+):\s(.*)/);
		var key;
		var value;
		if (matches === null) {
			return;
		}
		key = matches[1];
		value = matches[2];
		if (typeof currentKey[key] !== 'undefined') {
			results.push(currentKey);
			currentKey = {};
		}
		currentKey[key] = value;
	});
	if (Object.keys(currentKey).length) {
		results.push(currentKey);
	}
	return results;
};

module.exports = {
	list: function () {
		return when.promise((resolve, reject) => {
			process.env.AVDMANAGER_EXIT_CONSOLE = 1;
			const cmd = AVD_MANAGER_CMD + ' list avd';
			shell.exec(cmd, {
				silent: true,
				timeout: 10000
			}, (code, stdout, stderr) => {
				if (code === 0) {
					debug('list: success with: ' + stdout);
					resolve(processKeyValueGroups(stdout));
				} else {
					console.error('list : error occured running: ' + cmd);
					console.error(stdout);
					console.error(stderr);
					console.error(code);
					reject({stdout: stdout, stderr: stderr, code: code});
				}
			});
		});
	},

	//Alternate create syntax may be forced in the future
	//avdmanager create avd --force --name appiumEmulatorApi22 --package android-22 --abi google_apis/x86
	create: function (name, options) {
		debug('emulator options: ' + JSON.stringify(options));
		return when.promise((resolve, reject) => {
			let cmd = ECHO_CMD + ' no | ' + AVD_MANAGER_CMD + ' create avd --force --name ' + name;
			// naive CLI command build
			for (let option in options) {
				debug(options[option]);
				cmd += ' --' + option + ' ' + options[option];
			}
			if (helpers.isWindows() === true) { //Works don't question it.
				cmd = cmd.replace(/'/g, '"');
			}
			debug('emulator.create:', cmd);
			process.env.AVDMANAGER_EXIT_CONSOLE = 1;
			shell.exec(cmd, {
				silent: true,
				timeout: 30000
			}, (code, stdout, stderr) => {
				if (code === 0 && !/Error:/.test(stdout) &&
					(/Do you wish to create a custom hardware profile/.test(stdout) ||
						/Created AVD/.test(stdout)) ||
					/Aborting/.test(stdout)) {
					debug('emulator.create: success');
					debug(stdout);
					resolve('emulator.create: success');
				} else {
					console.error('emulator.create: error occured running', cmd);
					console.error(code);
					console.error(stdout);
					console.error(stderr);
					reject({stdout: stdout, stderr: stderr, code: code});
				}
			});
		});

	},
	start: function (name, launchOptions) {
		// start given emulator with a random port and wait for boot to complete
		debug('Android avd start launch options: ' + launchOptions);
		return helpers
			.checkHaxmIsUsable(EMULATOR_CMD)
			.then(() => {
				//TODO get rid of the defer
				var defer = Q.defer();

				function checkBooted(port, bootAttempts) {
					bootAttempts += 1;
					if (defer.promise.isRejected()) {
						return;
					}
					var checkCmd = ADB_CMD + ' -s emulator-' + port + ' shell getprop sys.boot_completed';
					debugTrace('Running checkBooted: ' + checkCmd);
					shell.exec(checkCmd, {
						silent: true,
						timeout: 5000
					}, function (code, stdout, stderr) { //shelljs does not return an error param but error code instead on failure
						debugTrace(`sys.boot_completed code: ${code} 'stdout:' ${stdout} stderr: ${stderr}`);
						if (bootAttempts >= EMUALTOR_POLL_LIMIT) {
							defer.reject({
								id: null,
								type: null,
								port: port,
								output: {stdout, stderr},
								error: 'could not load emulator in with : ' + bootAttempts
							});
						} else if (code !== 0) {
							setTimeout(checkBooted.bind(this, port, bootAttempts), 1000);
						} else if (code === 0 && /1/gi.test(stdout) === false) { //this returns empty for the first few polls
							setTimeout(checkBooted.bind(this, port, bootAttempts), 1000);
						} else { // need another catch if haxm doesn't launch
							debug('emulator booted in: ' + bootAttempts + ' attempts');
							defer.resolve({
								id: 'emulator-' + port,
								port: port,
								type: 'emulator',
								bootAttempts: bootAttempts
							});
						}
					});
				}

				// find a random port then start emulator
				helpers.randomPort(START_PORT_RNAGE, END_PORT_RANGE, 1, function (port) {
					var emulatorLogDir = path.join(__dirname, '..', 'results', 'emulator.log');
					var emulatorErrorLogDir = path.join(__dirname, '..', 'results', 'emulatorError.log');
					when
						.all([fs.ensureFile(emulatorLogDir), fs.ensureFile(emulatorErrorLogDir)])
						.then(() => {
							when
								.join(fs.open(emulatorLogDir, 'w'), fs.open(emulatorErrorLogDir, 'w'))
								.then((logFiles) => {
									let outLog = logFiles[0];
									let errLog = logFiles[1];
									const launchOptionsList = ['-avd', name, '-port', port].concat(launchOptions.split(' '));
									debug('emulator.start:', launchOptionsList);
									let spawnOptions = {
										detached: true,
										stdio: ['ignore', outLog, errLog],
									};
									var child = spawn(EMULATOR_CMD, launchOptionsList, spawnOptions);
									debug(`Spawned child pid: ${child.pid}`);
									child.on('error', (error) => {
										console.error('Failed to start child process with error: ' + JSON.stringify(error));
										defer.reject({
											id: null,
											type: null,
											port: null,
											error: 'Failed to start child process with error : ' + error
										});
									});
									setTimeout(function () {
										defer.reject({
											id: null,
											type: null,
											port: port,
											error: `timeout Rejection in emulator.start: at ${EMULATOR_START_TIMEOUT_MS} ms`
										});
									}, EMULATOR_START_TIMEOUT_MS);
									startTailOnLogs(emulatorLogDir, port, defer);
									startTailOnLogs(emulatorErrorLogDir, port, defer);
									child.unref();
									// start polling for device ready
									checkBooted(port, 0);
								});
						});
				});
				return defer.promise;
			});
	},

	setHardwareOptions: function (avdName, avdList, hardwareOptions) {
		return when.promise(function (resolve, reject) {
			if (!avdName || !avdList || !hardwareOptions) {
				reject(new Error('setHardwareOptions: Need avdName, avdList and hardware options to set options'));
			}
			var avd = _.find(avdList, {Name: avdName});
			if (!avd) {
				reject('setHardwareOptions: avd ' + avdName + ' could not be listed');
			}
			var configFile = path.join(avd.Path, 'config.ini');
			debug('using emulator config: ' + configFile);
			//var iniFile = fs.readFileSync(configFile, 'utf8'); //tests can't run till completed dont care if sync
			fs.readFile(configFile, 'utf8', (err, data) => {
				if (err) {
					reject(new Error(err));
				}
				var config = ini.parse(data);
				//TODO bad properties injected won't be cleared, need a reset but need to keep certain keys
				Object.keys(hardwareOptions).forEach(function (key) {
					config[key] = hardwareOptions[key];
				});
				fs.writeFile(configFile, ini.stringify(config), 'utf8', (writeError) => {
					if (writeError) {
						reject(new Error(writeError));
					} else {
						var sdCardPath = path.join(avd.Path, 'sdcard.img');
						if (!config['sdcard.size']) {
							reject(new Error('setHardwareOptions: Need sd card size to be set'));
						}
						var createSDcardCmd = SDCARD_CMD + ' ' + config['sdcard.size'] + ' ' + sdCardPath;
						shell.exec(createSDcardCmd, {
							silent: false,
							timeout: 20000
						}, function (code, output) {
							if (code === 0 && !/error/.test(output)) {
								debug('setHardwareOptions.mksdcard: success');
								resolve('setHardwareOptions: success');
							} else {
								console.error('mksdcard: error', output);
								reject(new Error('setHardwareOptions.mksdcard: error: ' + output));
							}
						});
					}
				});
			});
		});
	},

	/* valid values for network speed
	 gsm      GSM/CSD
	 hscsd    HSCSD
	 gprs     GPRS
	 edge     EDGE/EGPRS
	 umts     UMTS/3G
	 hsdpa    HSDPA
	 full     no limit
	 <num>    selects both upload and download speed
	 <up>:<down> select individual upload/download speeds*/
	setNetwork: function (networkValue, emulatorPort) {
		var cmd = 'network speed ' + networkValue;
		return helpers.sendAndroidTelnetCommand(cmd, emulatorPort)
			.then((result) => {
				debug('Success at updating networkspeed to: ' + networkValue + ' via telnet');
				return result;
			})
			.catch((error) => {
				console.error('Could not set networkspeed via telnet to device');
				console.error(error);
			});
	},

	/*'geo fix <longitude> <latitude> [<altitude> [<satellites>]]'
	 allows you to send a simple GPS fix to the emulated system.
	 The parameters are:

	 <longitude>   longitude, in decimal degrees
	 <latitude>    latitude, in decimal degrees
	 <altitude>    optional altitude in meters
	 <satellites>  number of satellites being tracked (1-12)
	 */
	setLocation: function (longitude, latitude, altitude, numSatellites, emulatorPort) {
		if (_.isNil(emulatorPort)) {
			throw new Error(`Need to specify emulator port for emulator:setLocation`);
		}
		var cmd = 'geo fix ' + longitude + ' ' + latitude + ' ' + altitude + ' ' + numSatellites;
		return helpers.sendAndroidTelnetCommand(cmd, emulatorPort)
			.then((result) => {
				debug(`setLocation:success lat:${latitude} lon:${longitude} alt:${altitude}`);
				return result;
			})
			.catch((error) => {
				console.error('Could not set geolocation via telnet to device');
				console.error(error);
			});
	},

	stop: function (device) {
		var cmd = null;
		if (!device.port && !device.serial && !device.id) {
			return when.reject(new Error('need serial,id or port to stop emulator'));
		}
		if (device.port) {
			cmd = ADB_CMD + ' -s emulator-' + device.port + ' emu kill';
		} else if (device.id) {
			cmd = ADB_CMD + ' -s ' + device.id + ' emu kill';
		} else {
			cmd = ADB_CMD + ' -s ' + device.serial + ' emu kill';
		}
		debug('stop device is: ' + JSON.stringify(device));
		return helpers.execSystemCommand(cmd, 'emulator.stop')
			.then((result) => {
				debug(result.message);
				return result;
			})
			.catch((error) => {
				debug('execSystemCommand emulator.stop failed because: ' + error);
				debug('trying force kill method');
				if (device.port) {
					debug('Doing emulator:stop with port');
					return helpers.doShellKillByPort(device.port, {name: 'qemu'});
				} else if (device.serial) {
					//TODO this is only going to work for stock Android avd's
					debug('Doing emulator:stop with id');
					var guessedPort = device.serial.substring(device.serial.indexOf('-') + 1);
					return helpers.doShellKillByPort(guessedPort, {name: 'qemu'});
				} else {
					throw new Error(error.message);
				}
			});
	},

	setTimeZone: function (device, timeZone) {
		var cmd = null;
		if (!device.port && !device.serial && !device.id) {
			return when.reject(new Error('need serial,id or port to stop emulator'));
		}
		if (device.port) {
			cmd = ADB_CMD + ' -s emulator-' + device.port + ' shell setprop persist.sys.timezone "' + timeZone + '"';
		} else if (device.id) {
			cmd = ADB_CMD + ' -s ' + device.id + ' shell setprop persist.sys.timezone "' + timeZone + '"';
		} else {
			cmd = ADB_CMD + ' -s ' + device.serial + ' shell setprop persist.sys.timezone "' + timeZone + '"';
		}
		return helpers.execSystemCommand(cmd, 'emulator.timeZone')
			.then((result) => {
				debug(result.message);
				return result;
			});
	},

	enableLocation: function (device){
		let andoroid6plusCmd = null;
		let androidCmd = null;
		const settingsPrefix = ' shell settings put secure location_providers_allowed ';
		if (!device.port && !device.serial && !device.id) {
			return when.reject(new Error('need serial,id or port to stop emulator'));
		}
		if (device.port) {
			andoroid6plusCmd = ADB_CMD + ' -s emulator-' + device.port + settingsPrefix + '+gps';
			androidCmd = ADB_CMD + ' -s emulator-' + device.port + settingsPrefix + 'gps';
		} else if (device.id) {
			andoroid6plusCmd = ADB_CMD + ' -s ' + device.id + settingsPrefix + '+gps';
			androidCmd = ADB_CMD + ' -s ' + device.id + settingsPrefix + 'gps';
		} else {
			andoroid6plusCmd = ADB_CMD + ' -s ' + device.serial + settingsPrefix + '+gps';
			androidCmd = ADB_CMD + ' -s ' + device.serial + settingsPrefix + 'gps';
		}
		return when.all(
			[
			helpers.execSystemCommand(andoroid6plusCmd, 'settings location_providers_allowed +gps, +network'),
			helpers.execSystemCommand(androidCmd, 'settings location_providers_allowed gps, network')
			])
			.catch((error) => {
			debug(`Suppressing and continuing from showScreenMovement Error: ${error}`);
			console.warn(`Suppressing and continuing from showScreenMovement Error: ${error}`);
		});
	},

	// Investigate doing this async all but would assume android doesn't like its settings modified by to calls at once.
	showScreenMovement: function (device) {
		let pointerCmd = null;
		let touchesCmd = null;
		const settingsPrefix = ' shell settings put system ';
		if (!device.port && !device.serial && !device.id) {
			return when.reject(new Error('need serial,id or port to stop emulator'));
		}
		if (device.port) {
			pointerCmd = ADB_CMD + ' -s emulator-' + device.port + settingsPrefix + 'pointer_location 1';
			touchesCmd = ADB_CMD + ' -s emulator-' + device.port + settingsPrefix + 'show_touches 1';
		} else if (device.id) {
			pointerCmd = ADB_CMD + ' -s ' + device.id + settingsPrefix + 'pointer_location 1';
			touchesCmd = ADB_CMD + ' -s ' + device.id + settingsPrefix + 'show_touches 1';
		} else {
			pointerCmd = ADB_CMD + ' -s ' + device.serial + settingsPrefix + 'pointer_location 1';
			touchesCmd = ADB_CMD + ' -s ' + device.serial + settingsPrefix + 'show_touches 1';
		}
		return helpers.execSystemCommand(pointerCmd, 'settings pointer_location')
			.then((result1) => {
				debug(result1.message);
				return helpers
					.execSystemCommand(touchesCmd, 'settings show_touches')
					.then((result2) => {
						debug(result2.message);
						return [result1, result2];
					});
			})
			.catch((error) => {
				debug(`Suppressing and continuing from showScreenMovement Error: ${error}`);
				console.warn(`Suppressing and continuing from showScreenMovement Error: ${error}`);
			});
	},

	runningTime: function (device) {
		return when.promise(function (resolve, reject) {
			var cmd = null;
			if (!device) {
				reject(new Error('need a device to query emulator'));
			}
			if (!device.port && !device.serial && !device.id) {
				reject(new Error('need serial or port to stop emulator'));
			}
			if (device.port) {
				cmd = ADB_CMD + ' -s emulator-' + device.port + ' shell cat /proc/uptime';
			} else if (device.id) {
				cmd = ADB_CMD + ' -s ' + device.id + ' shell cat /proc/uptime';
			} else {
				cmd = ADB_CMD + ' -s ' + device.serial + ' shell cat /proc/uptime';
			}
			debug(cmd);
			shell.exec(cmd, {
				silent: false,
				timeout: 10000
			}, function (code, stdout, stderr) {
				if (code === 0 && !/error/.test(stdout)) {
					debug('emulator.runningTime: success');
					try {
						resolve(_.toInteger(stdout.split(' ')[0])); //running time in seconds
					}
					catch (error) {
						reject(new Error('problem parsing stdout to int: ' + error));
					}
				} else {
					console.error('emulator.runningTime: error', stderr);
					reject(new Error(stderr));
				}
			});

		});
	},

	checkAvdTarget: function (avdName, desiredOptions) {
		return when.promise((resolve, reject) => {
			var desiredTarget = desiredOptions.target;
			var avdIni = path.join(ANDROID_AVD_USER_DIR, avdName + '.ini');
			fs.accessSync(avdIni, fs.R_OK);
			fs.readFile(avdIni, 'utf8', (err, data) => {
				if (err) {
					reject(err);
				}
				var config = ini.parse(data);
				if (config.target !== desiredTarget) {
					reject('avd Parsed ini does not match desired ini' + JSON.stringify(config) + ' : ' + JSON.stringify(desiredOptions));
				} else {
					debug('emulator parsed target ini matches desired');
					resolve();
				}
			});
		});
	},
	sleep: function (sleepTime) {
		return when.promise(function (resolve) {
			debug('sleeping for: ' + sleepTime);
			setTimeout(function () {
				debug('slept for : ' + sleepTime);
				resolve();
			}, sleepTime);
		});
	}
};
