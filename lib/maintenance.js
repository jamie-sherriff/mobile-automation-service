/**
 * Created by jamie on 25/05/16.
 */
'use strict';
var debug = require('debug')('automation:server:maintenance');
var path = require('path');
var when = require('when');
var fs = require('fs-extra');
var _ = require('lodash');
var os = require('os');
var whenNode = require('when/node');
var fsPromise = whenNode.liftAll(require('fs-extra'));
var USER_HOME_DIR = os.homedir();
var ANDROID_AVD_USER_DIR = path.join(USER_HOME_DIR, '.android', 'avd');


function checkFileWriteAccess(filePath) {
    return when.promise((resolve, reject) => {
        fs.access(filePath, fs.W_OK, (error) => {
            if (error) {
                reject((error));
            } else {
                resolve(filePath);
            }
        });
    });
}

function filterValidFiles(settledArray) {
    return when
        .filter(settledArray, function (obj) {
            if (obj.state !== 'rejected') {
                return obj;
            } else {
                if (obj.reason.code === 'ENOENT') {
                    debug(obj.reason.path + ' Does not exist');
                } else {
                    throw new Error('something went wrong with: ' + JSON.stringify(obj));
                }
            }
        })
        .then((array) => {
            return _.map(array, function (obj) {
                return obj.value;
            });
        });
}

function deleteFile(filePath) {
    return when.promise((resolve, reject) => {
        fs.remove(filePath, (error) => {
            if (error) {
                reject(new Error(error));
            } else {
                resolve('Removed: ' + filePath);
            }
        });
    });
}

function findAndroidFiles(androidJson) {
    var iniFileArray = [];
    var avdFolderArray = [];
    for (var key in androidJson) {
        var androidIniFile = path.join(ANDROID_AVD_USER_DIR, key + '.ini');
        var androidAvdDir = path.join(ANDROID_AVD_USER_DIR, key + '.avd');
        iniFileArray.push(checkFileWriteAccess(androidIniFile));
        avdFolderArray.push(checkFileWriteAccess(androidAvdDir));
    }
    return {iniFileArray, avdFolderArray};
}

function deletefileList(fileList) {
    var deleteFileArray = [];
    fileList.forEach((file) => {
        deleteFileArray.push(deleteFile(file));
    });
    return deleteFileArray;
}

module.exports.resetKnownAvds = function (configOptions) {
    if (configOptions.deleteKnownAvds) {
        var androidJson = require('.././android-emulators.json');
        var promisedAndroidFiles = findAndroidFiles(androidJson);
        var settled = when.settle(_.concat(promisedAndroidFiles.iniFileArray, promisedAndroidFiles.avdFolderArray));
        return filterValidFiles(settled)
            .then(function (resolvedFileList) {
                debug(resolvedFileList);
                return when
                    .all(deletefileList(resolvedFileList));
            })
            .catch((error) => {
                console.error(error);
                throw new Error(error);
            });
    } else {
        return when.resolve('Not deleting known Avds');
    }
};

module.exports.clearBenchMarkDir = function (configOptions) {
    if (configOptions.cleanOnStartup === true) {
        debug('removing benchmarking at: ' + configOptions.benchmarkDir);
        return fsPromise
            .remove(configOptions.benchmarkDir)
            .then(() => {
                return 'clearBenchMarkDir removal operation success';
            });
    } else {
        return when.resolve('clearBenchMarkDir skipped');
    }
};

module.exports.clearScreenshotDir = function (configOptions) {
    if (configOptions.cleanOnStartup === true) {
        debug('removing screenshots at: ' + configOptions.screenshotDir);
        return fsPromise
            .remove(configOptions.screenshotDir)
            .then(() => {
                return fsPromise
                    .remove('tmp')
                    .then(() => {
                        return 'clearScreenshotDir removal operation success';

                    });
            });
    } else {
        return when.resolve('clearScreenshotDir skipped');
    }

};