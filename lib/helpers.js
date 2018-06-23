/**
 * Created by jamie on 13/04/16.
 */
'use strict';
const when = require('when');
const exec = require('child_process').exec;
const execSync = require('child_process').execSync;
const os = require('os');
const debug = require('debug')('automation:server:helpers');
const debugTrace = require('debug')('automation-trace:server:helpers');
const _ = require('lodash');
const whenNode = require('when/node');
const which = require('which');
const promisedWhich = whenNode.lift(which);
const net = require('net');

module.exports.getApplicationUser = function (userList, requestArgs) {
	if (requestArgs.overrideUser === true) {
		debug('using Custom User');
		return 'Using Custom user';
	} else {
		try {
			return userList.shift();
		} catch (error) {
			throw new Error('Could not shift application user off list: ' + error);
		}
	}
};

function execSystemCommand(cmd, message, failRegex, cmdOptions = {timeout: 10000, killSignal: 'SIGTERM'}) {
	return when.promise((resolve, reject) => {
		failRegex = failRegex || /error/;
		debug('Performing shellCmd for: ' + message + ' with cmd: ' + cmd);
		exec(cmd, cmdOptions, (error, stdout, stderr) => {
			if (error) {
				debug(error);
				error.message += 'cmd: ' + message + ' failed: ' + cmd + ' with error: ' + JSON.stringify(error);
				error.stdout = stdout;
				error.stderr = stderr;
				if (error.signal === 'SIGTERM') {
					console.error(`found SIGTERM so likely a timeout error at ${cmdOptions.timeout}ms`);
					error.timeout = cmdOptions.timeout;
				}
				reject(error);
			} else if (failRegex.test(stdout) || failRegex.test(stderr)) {
				reject({
					stdout: stdout,
					stderr: stderr,
					message: message + ' Failed because it found ' + failRegex
				});
			} else {
				resolve({
					stdout: stdout,
					stderr: stderr,
					message: message + ' succeeded'
				});
			}
		});
	});
}

function isWindows() {
	return os.platform() === 'win32';
}

function getAndroidHome() {
	var androidHome = process.env.ANDROID_HOME;
	if (!androidHome) {
		throw new Error('ANDROID_HOME must be set');
	}
	return androidHome;
}

function pidsFromNetStat(netstatOutput) {
	if (_.isArray(netstatOutput) === true) {
		return netstatOutput.map((row) => {
			return row.split(',')[4];
		});
	} else { //Assume single string case
		return [netstatOutput.split(',')[4]];
	}
}

function randomPort(startNumber, endNumber, attempts, callback) {
	const range = (endNumber - startNumber) / 2,
		port = startNumber + ~~(Math.random() * range) * 2;
	if (attempts > 30) {
		throw new Error('randomPort Attempts has been reached');
	}
	debug(`listening to port ${port} with attempt: ${attempts}`);
	const server = net.createServer();
	server.listen(port, function (error) {
		if (error) {
			console.error(error);
		}
		server.once('close', function () {
			debug(`Sending ${port} as free`);
			callback(port);
		});
		server.close();
	});
	server.on('error', function (error) {
		console.error(error);
		randomPort(attempts += 1, callback);
	});
}

function checkHaxmIsUsable(EMULATOR_CMD) {
	if (isWindows() === true) {
		let scCmd = which.sync('sc');
		scCmd = scCmd + ' query intelhaxm';
		return execSystemCommand(scCmd, 'query haxm')
			.then((cmdOutput) => {
				const stdout = cmdOutput.stdout;
				debug(`*** sc query intelhaxm output: ${stdout} *** `);
				if (/STOPPED/g.test(stdout) === true) {
					debug('Error trying to check haxm: ' + stdout);
					return when.reject('intel haxm is not running: ' + JSON.stringify(cmdOutput));
				} else {
					return cmdOutput;
				}
			});

	} else {
		const accelCheckCmd = EMULATOR_CMD + ' -accel-check';
		return execSystemCommand(accelCheckCmd, 'query accelCheckCmd unix')
			.then((cmdOutput) => {
				const stdout = cmdOutput.stdout;
				debug(`*** accelCheckCmd output: ${stdout} ***`);
				if (/is installed and usable/g.test(stdout) === false) {
					debug('Error trying to check haxm: ' + stdout);
					return when.reject('unix intel haxm is not running: ' + JSON.stringify(cmdOutput));
				} else {
					return cmdOutput;
				}
			});
	}
}

module.exports.execSystemCommandSync = function (cmd, message, cmdOptions) {
	var options = cmdOptions || {timeout: 5000};
	debug('Performing execSystemCommandSync for: ' + message + ' with cmd: ' + cmd);
	try {
		let stdout = execSync(cmd, options);
		return stdout.toString();
	} catch (error) {
		return error;
	}
};

module.exports.pidForWindows = (csvFormattedString) => {
	return parseInt(csvFormattedString.split(',')[1].replace(/"/g, ''));
};


module.exports.doShellKillByPort = (port, options={name: null}) => {
	let cmd = null;
	if (isWindows() === true) {
		//OutputFormat Proto, Local Address, Foreign Address,State, PID
		cmd = `powershell -command "((netstat -aon | findstr :${port}) -replace '^\\s+','') -replace '\\s+',',' | ConvertTo-JSON"`;
		return execSystemCommand(cmd, 'windows findpidByPort')
			.then((netstatOutput) => {
				debug(netstatOutput);
				let parsedOutput = JSON.parse(netstatOutput.stdout);
				debug(parsedOutput);
				let listOfPids = _.uniq(pidsFromNetStat(parsedOutput));
				if (listOfPids.length < 1 ||_.isEmpty(listOfPids) === true || _.isUndefined(listOfPids) === true) {
					return when.reject('Could not find any windows pids to kill: ' + netstatOutput);
				}
				debug('killing Windows pids by port: ' + listOfPids);
				let promises = [];
				listOfPids.forEach((pid) => {
					promises.push(
						execSystemCommand('taskKill /f /pid ' + pid, 'taskKill win32 on pid: ' + pid)
					);
				});
				return when.join(promises);
			});
	} else {
		return when.join(promisedWhich('kill'), promisedWhich('lsof'))
			.then((resolvedPaths) => {
				const killPath = resolvedPaths[0];
				const lsofPath = resolvedPaths[1];
				let lsOfCmd;
				if (options.name){
					lsOfCmd =  `${lsofPath} -a -t -i:${port} -c ${options.name}`;
				} else {
					lsOfCmd = `${lsofPath} -a -t -i:${port}`;
				}
				return execSystemCommand(lsOfCmd, `lsof on:${port}`).then((lsofResult) => {
					debug(lsofResult);
					const foundPid = lsofResult.stdout.trim().replace(/\n/g, ' ');
					if(_.isEmpty(foundPid) === false){
						const killCmd = `${killPath} ${foundPid}`;
						return execSystemCommand(killCmd, `Doing kill forPid: ${foundPid}`);
					}
				});
			});
	}
};

var sendAndroidTelnetCommand = function (command, emulatorPort, host='localhost') {
	if (_.isNil(emulatorPort)) {
		throw new Error(`Need to specify emulator port for command: ${command}`);
	}
	return when.promise((resolve, reject) => {
		debug('Sending telnet command to port:' + emulatorPort + ' ' + command);
		let telentOptions = {
			port: emulatorPort,
			host: host,
			timeout: 7500
		};
		let conn = net.createConnection(telentOptions, () => {
			debugTrace('connected to ' + telentOptions.host + ' emulator at: ' + telentOptions.port);
		});
		let connected = false;
		const readyRegex = /^OK$/m;
		const failRegex = /^KO/m;
		let dataStream = '';
		let res = null;
		let onReady = function () {
			conn.write(command + '\n');
		};
		conn.on('error', (error) => {
			debug('telnet emulator error ' + telentOptions.host + ':' + telentOptions.port + ' with error' + error);
			reject(new Error(`telnet connection error ${error}`));
		});
		conn.on('timeout', () => {
			debug('telnet emulator ' + telentOptions.host + ':' + telentOptions.port + ' timeout error');
			conn.end('quit\n');
			reject(new Error('telnet timeout error'));
		});
		conn.on('data', function (data) {
			data = data.toString('utf8');
			if (failRegex.test(data)) {
				debug(`sendTelnetCommand failed with data response:`);
				debug(data);
				reject({data: data, message: 'sendTelnetCommand found KO error', command: command});
			} else if (!connected) {
				if (readyRegex.test(data)) {
					connected = true;
					onReady();
				}
			} else {
				dataStream += data;
				if (readyRegex.test(data)) {
					res = dataStream.replace(readyRegex, '').trim();
					debugTrace(`telnetData: ${dataStream}`);
					conn.end('quit\n');
				}
			}
		});
		conn.on('close', function () {
			if (res === null) {
				reject(new Error('Never got a response from command'));
			} else {
				resolve(res);
			}
		});
	});
};

module.exports.isWindows = isWindows;
module.exports.execSystemCommand = execSystemCommand;
module.exports.pidsFromNetStat = pidsFromNetStat;
module.exports.checkHaxmIsUsable = checkHaxmIsUsable;
module.exports.randomPort = randomPort;
module.exports.getAndroidHome = getAndroidHome;
module.exports.sendAndroidTelnetCommand = sendAndroidTelnetCommand;