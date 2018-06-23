/**
 * Created by jamie on 07/04/17.
 */
'use strict';
/* eslint-disable */
/*jshint loopfunc: true */
//  ffmpeg -framerate 5 -i e1ead3f805564759/%05d.jpg -crf 30 -tune animation output8.mp4
var WebSocket = require('ws');
var WebSocketServer = WebSocket.Server;
const net = require('net');
var adb = require('adbkit');
var _ = require('lodash');
var debug = require('debug')('automation:playing');
const path = require('path');
const fs = require('fs-extra');
const when = require('when');
var whenNode = require('when/node');
var fsPromise = whenNode.liftAll(require('fs-extra'));
const miniCapRootPath = path.resolve('device_server', 'minicap');
const screnshotDirRoot = path.resolve('device_server', 'screnshots');

module.exports.init = function (adbClient, deviceSerial, tcpPort = 1717) {
    var server = require('http').createServer();
    server.on('error', (error) => {
        console.error(error);
    });
    var PORT = process.env.PORT || 9002;
    console.log('in init');
    const screenshotDir = path.join(screnshotDirRoot, deviceSerial);
    var wss = new WebSocketServer({server: server});

    wss.on('connection', function (ws) {
        console.info('Got a client');

        var stream = net.connect({
            port: tcpPort
        });

        stream.on('error', function () {
            console.error('Be sure to run `adb forward tcp:1717 localabstract:minicap`');
            return adbClient.forward(deviceSerial, 'tcp:1717', 'localabstract:minicap');
        });
        let frameCount = 0;
        let savedFrameCount = 0;
        var readBannerBytes = 0;
        var bannerLength = 2;
        var readFrameBytes = 0;
        var frameBodyLength = 0;
        var frameBody = new Buffer(0);
        var banner = {
            version: 0, length: 0, pid: 0, realWidth: 0, realHeight: 0, virtualWidth: 0, virtualHeight: 0, orientation: 0, quirks: 0
        };

        function tryRead () {
            for (var chunk; (chunk = stream.read());) {
                //console.info('chunk(length=%d)', chunk.length);
                for (var cursor = 0, len = chunk.length; cursor < len;) {
                    if (readBannerBytes < bannerLength) {
                        switch (readBannerBytes) {
                            case 0:
                                // version
                                banner.version = chunk[cursor];
                                break;
                            case 1:
                                // length
                                banner.length = bannerLength = chunk[cursor];
                                break;
                            case 2:
                            case 3:
                            case 4:
                            case 5:
                                // pid
                                banner.pid +=
                                    (chunk[cursor] << ((readBannerBytes - 2) * 8)) >>> 0;
                                break;
                            case 6:
                            case 7:
                            case 8:
                            case 9:
                                // real width
                                banner.realWidth +=
                                    (chunk[cursor] << ((readBannerBytes - 6) * 8)) >>> 0;
                                break;
                            case 10:
                            case 11:
                            case 12:
                            case 13:
                                // real height
                                banner.realHeight +=
                                    (chunk[cursor] << ((readBannerBytes - 10) * 8)) >>> 0;
                                break;
                            case 14:
                            case 15:
                            case 16:
                            case 17:
                                // virtual width
                                banner.virtualWidth +=
                                    (chunk[cursor] << ((readBannerBytes - 14) * 8)) >>> 0;
                                break;
                            case 18:
                            case 19:
                            case 20:
                            case 21:
                                // virtual height
                                banner.virtualHeight +=
                                    (chunk[cursor] << ((readBannerBytes - 18) * 8)) >>> 0;
                                break;
                            case 22:
                                // orientation
                                banner.orientation += chunk[cursor] * 90;
                                break;
                            case 23:
                                // quirks
                                banner.quirks = chunk[cursor];
                                break;
                        }

                        cursor += 1;
                        readBannerBytes += 1;

                        if (readBannerBytes === bannerLength) {
                            console.log('banner', banner);
                        }
                    }
                    else if (readFrameBytes < 4) {
                        frameBodyLength += (chunk[cursor] << (readFrameBytes * 8)) >>> 0;
                        cursor += 1;
                        readFrameBytes += 1;
                        //console.info('headerbyte%d(val=%d)', readFrameBytes, frameBodyLength);
                    }
                    else {
                        if (len - cursor >= frameBodyLength) {
                            console.info('bodyfin(len=%d,cursor=%d)', frameBodyLength, cursor);

                            frameBody = Buffer.concat([
                                frameBody, chunk.slice(cursor, cursor + frameBodyLength)
                            ]);

                            // Sanity check for JPG header, only here for debugging purposes.
                            if (frameBody[0] !== 0xFF || frameBody[1] !== 0xD8) {
                                console.error(
                                    'Frame body does not start with JPG header', frameBody);
                                //process.exit(1);
                            }
                            frameCount++;
                            if (frameCount % 1 === 0) {

                                wss.clients.forEach(function each (client) {
                                    if (client.readyState === WebSocket.OPEN) {
                                        client.send(frameBody, {
                                            binary: true
                                        });
                                    }
                                });


                                // ws.send(frameBody, {
                                //     binary: true
                                // });


                                savedFrameCount++;
                                const fileName = path.join(screenshotDir, _.padStart(savedFrameCount, 5, '0') + '.jpg');
                                fs.outputFile(fileName, frameBody, {encoding: 'binary'});
                            } else {
                                console.log('discarding frame');
                            }

                            cursor += frameBodyLength;
                            frameBodyLength = readFrameBytes = 0;
                            frameBody = new Buffer(0);
                        }
                        else {
                            //console.info('body(len=%d)', len - cursor);

                            frameBody = Buffer.concat([
                                frameBody, chunk.slice(cursor, len)
                            ]);

                            frameBodyLength -= len - cursor;
                            readFrameBytes += len - cursor;
                            cursor = len;
                        }
                    }
                }
            }
        }

        stream.on('readable', tryRead);

        ws.on('close', function () {
            console.info('Lost a client');
            stream.end();
        });
    });
    server.listen(PORT);
    console.info('Listening on port %d', PORT);
};

function uploadFile (deviceSerial, syncClient, filePath, remotePath) {
    return when.promise((resolve, reject) => {
        const godPermission = 0x1FF;
        console.log('uploadFile Pushing file: ' + filePath + ' to remote location: ' + remotePath);
        let transfer = syncClient.pushFile(filePath, remotePath, godPermission);
        transfer.on('progress', function (stats) {
            console.log('[%s] Pushed %d bytes so far',
                deviceSerial,
                stats.bytesTransferred);
        });
        transfer.on('end', function () {
            console.log('[%s] Push complete', deviceSerial);
            resolve('[%s] Push complete', deviceSerial);
        });
        transfer.on('error', function (error) {
            reject(error);
        });
    }).timeout(30000, 'uploadFile took to long doing: ' + filePath + ' : ' + remotePath);
}

function shellCommandWithOutput (deviceSerial, adbClient, command, timeoutMs = 30000, logOutput = false) {
    debug('running shellCommandWithOutput for : ' + command);
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

function shellCommandStream (deviceSerial, adbClient, command, timeoutMs = 30000) {
    debug('running shellCommandStream for : ' + command);
    return adbClient
        .shell(deviceSerial, command)
        .then((socket) => {
            socket.setTimeout(60 * 60 * 3600); //1 hour
            socket.on('data', (data) => {
                debug('socket@' + deviceSerial + ' data:' + data.toString());
            });

            socket.on('end', () => {
                debug('socket@' + deviceSerial + ' ended');
            });

            socket.on('error', (error) => {
                console.log(error);
                return when.reject(error);
            });
            socket.on('timeout', () => {
                console.log('socket timeout here');
                return when.reject(new Error('Socket timeout error for: ' + deviceSerial + ' with cmd' + command));
            });

            return when.resolve('socket created for: ' + deviceSerial + ' with commaand: ' + command).delay(3000); //give socket a chance to propagate errors
        }).timeout(timeoutMs, 'shellCommandStream doing: ' + command);
}

module.exports.setupDeviceForViewing = function (adbClient, deviceSerial) {
    return adbClient
        .syncService(deviceSerial)
        .then((syncClient) => {
            return adbClient
                .getProperties(deviceSerial)
                .then(function (properties) {
                    const abi = properties['ro.product.cpu.abi'];
                    const sdk = properties['ro.build.version.sdk'];
                    let binExec = null;
                    if (_.toInteger(sdk) >= 16) {
                        binExec = 'minicap';
                    } else {
                        binExec = 'minicap-nopie';
                    }
                    const release = properties['ro.build.version.release'];
                    console.log('Using screen stream on device: ' + deviceSerial + ' with args ' + abi + ' ' + sdk + ' ' + release);
                    const windowCmd = 'dumpsys window';
                    return shellCommandWithOutput(deviceSerial, adbClient, windowCmd)
                        .then((output) => {
                            let stringOutput = output.toString().trim();
							// eslint-disable-next-line no-useless-escape
							let matchedLine = stringOutput.match(new RegExp('init=([^\s]*)', 'ig'));
                            let sizeItem = matchedLine[0].split(' ')[2]; //0 init 2 cur 3 app 4rng
                            const size = sizeItem.substring(sizeItem.indexOf('=') + 1);
                            console.log(size);
                            const args = `-P ${size}@${size}/0`;
                            const localDir = '/data/local/tmp/minicap-devel';
                            const mkdirCmd = `mkdir ${localDir} 2>/dev/null || true`;
                            const runCommand = `LD_LIBRARY_PATH=${localDir} ${localDir}/${binExec} ${args}`;
                            return shellCommandWithOutput(deviceSerial, adbClient, mkdirCmd)
                                .then(function () {
                                    const binaryPath = path.resolve(miniCapRootPath, 'libs', abi, binExec);
                                    let remotefilePath = path.join(localDir, 'minicap');
                                    console.log(binaryPath);
                                    return uploadFile(deviceSerial, syncClient, binaryPath, remotefilePath);

                                })
                                .then(() => {
                                    return adbClient.forward(deviceSerial, 'tcp:1717', 'localabstract:minicap');
                                })
                                .then(() => {
                                    let libPath = path.resolve(miniCapRootPath, 'jni', 'minicap-shared', 'aosp', 'libs', 'android-' +
                                        release, abi, 'minicap.so');
                                    return fsPromise.access(libPath, fs.F_OK)
                                        .then(() => {
                                            return libPath;
                                        })
                                        .catch(() => {
                                            debug('error finding :' + libPath + ' trying alternative');
                                            libPath = path.resolve(miniCapRootPath, 'jni', 'minicap-shared', 'aosp', 'libs', 'android-' +
                                                sdk, abi, 'minicap.so');
                                            return fsPromise.access(libPath, fs.F_OK)
                                                .then(() => {
                                                    return libPath;
                                                });
                                        });
                                })
                                .then((filePath) => {
                                    console.log(filePath);
                                    let remotefilePath = path.join(localDir, 'minicap.so');
                                    // let cmd = ADB_CMD + ' push ' + filePath + ' ' + remotefilePath;
                                    // return doShellCmd(cmd, 'pushing')
                                    //     .then((result)=> {
                                    //         debug(result.message);
                                    //         return result;
                                    //     })
                                    //     .catch((error)=>{
                                    //     console.error(error.stack)
                                    //     })a
                                    return uploadFile(deviceSerial, syncClient, filePath, remotefilePath);

                                })
                                .then(() => {
                                    return shellCommandStream(deviceSerial, adbClient, runCommand, 30000, {logOutput: true})
                                        .then((output) => {
                                            console.log(output);
                                        });
                                });


                        });
                })
                .then(() => {
                    console.log('end here');
                    syncClient.end();
                })
                .catch((error) => {
                    console.error(error);
                    syncClient.end();
                });
        });
};