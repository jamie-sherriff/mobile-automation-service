/**
 * Created by jamie on 23/08/16.
 */
/**
 * Created by jamie on 22/08/16.
 */
'use strict';
//http://stackoverflow.com/questions/22372960/is-this-explanation-about-vss-rss-pss-uss-accurately

var _ = require('lodash');
var path = require('path');
var uuid = require('uuid');
var when = require('when');
var whenNode = require('when/node');
var fsPromise = whenNode.liftAll(require('fs-extra'));
var moment = require('moment');
var adb = require('adbkit');
var debug = require('debug')('automation:server:benchmark');
var fs = require('fs');
var android = require('./android');

const androidDumpSysCmd = 'dumpsys meminfo';
const androidDumpHeapCmd = 'am dumpheap';
const zlib = require('zlib');

function createLogMemoryLogFile(dir) {
    var logId = uuid.v4();
    var logFilePath = path.join(dir, logId + '.log');
    console.log(logFilePath);
    return fsPromise.ensureFile(logFilePath)
        .then(() => {
            return {path: logFilePath, id: logId};
        });
}

function updateMemoryFile(file, json) {
    var options = {encoding: 'utf8', flag: 'a'};
    if (typeof json !== 'object') {
        throw new Error('Did not get a type of object to write to file: ' + JSON.stringify(json));
    }
    return fsPromise.appendFile(file, JSON.stringify(json) + '\n', options);
}

function returnIntArrayForItem(item, itemRegex, contentArray) {
    var numberArray = null;
    contentArray.forEach((row) => {
        if (itemRegex.test(row)) {
            let stringArray = row.trim().replace(/\s{2,}/g, ',').split(',');
            if (stringArray[0].trim().toLowerCase() !== item.trim().toLowerCase()) {
                throw new Error('item does not match expected format: ' + item + ' ###StringArray: ' + stringArray);
            }
            numberArray = _.map(stringArray.slice(1), _.toInteger);
        }
    });
    return numberArray;
}

function returnIntArrayForArrayPairs(arrayOfItemArrays, contentArray) {
    var objectJson = {strings: [], numbers: []};
    contentArray.forEach((row) => {
        arrayOfItemArrays.forEach((arrayOfItems) => {
            var itemRegex = new RegExp('\\b' + arrayOfItems[0] + '\\b' + '.*' + '\\b' + arrayOfItems[1] + '\\b', 'i');
            if (itemRegex.test(row)) {
                var stringArray = row.trim().replace(/  +/g, ',').replace(/\s+/g, '').replace(/:/g, '').split(',');
                objectJson.strings.push(stringArray[0]);
                objectJson.numbers.push(_.toInteger(stringArray[1]));
                objectJson.strings.push(stringArray[2]);
                objectJson.numbers.push(_.toInteger(stringArray[3]));
            }
        });
    });
    return objectJson;
}

function returnStringArrayFromRegex(regex, contentArray) {
    var stringArray = null;
    contentArray.forEach((row) => {
        if (regex.test(row)) {
            stringArray = row.trim().replace(/\s+/g, ',').split(',');
        }
    });
    return stringArray;
}

function customMerge(objValue, srcValue) {
    return srcValue + objValue;
}

function generateMemoryObject(arrayOfStrings, arrayOfNumbers) {
    if (arrayOfNumbers instanceof Array === false) {
        throw new Error('generateMemoryObject arrayOfNumbers is not valid: ' + arrayOfNumbers);
    }
    var memoryJson = {};
    arrayOfStrings.forEach((string, index) => {
        memoryJson[_.lowerFirst(string)] = arrayOfNumbers[index];
    });
    return memoryJson;
}

function formatMemoryUsageText(text) {
    var errorRegex = new RegExp('(No Process found|Exception)', 'i');
    if (errorRegex.test(text)) {
        throw new Error('Error found while trying to process text "' + text + '"');
    }
    var memoryJson = {};
    var topSplit, header, contentArray;
    //Android < 7 path
    if (text.includes('\r\n\r\n') === true) {
        topSplit = text.split('\r\n\r\n');
        header = topSplit[0];
        contentArray = topSplit[1].split('\r\n');
        memoryJson.upTime = _.toInteger(header.split('\r\n')[1].split(' ')[1]);
        memoryJson.realTime = _.toInteger(header.split('\r\n')[1].split(' ')[3]);
    } else {
        topSplit = text.split('\n\n');
        header = topSplit[0];
        contentArray = topSplit[1].split('\n');
        memoryJson.upTime = _.toInteger(header.split('\n')[1].split(' ')[1]);
        memoryJson.realTime = _.toInteger(header.split('\n')[1].split(' ')[3]);
    }
    //TODO If order doesn't change should change to \bPss\b.*\bPrivate\b.*\bSwapped\b.*\bHeap\b
    let memInfoTop = returnStringArrayFromRegex(new RegExp('(?=.*\\bPss\\b)(?=.*\\bPrivate\\b)(?=.*\\bSwapped\\b)(?=.*\\bHeap\\b).*', 'i'), contentArray);
    let memInfoBottom = returnStringArrayFromRegex(new RegExp('(?=.*Total)(?=.*Dirty)(?=.*Alloc)(?=.*Free).* ', 'i'), contentArray);
    let memInfoJoined = _.mergeWith(memInfoBottom, memInfoTop, customMerge);
    //TODO this will fail if memory usage exceeds 7 digits, need a NOT wraparound included for android 6?
    memoryJson.usage = generateMemoryObject(memInfoJoined, returnIntArrayForItem('TOTAL', new RegExp('\\bTOTAL\\b\\s{2}'), contentArray));
    memoryJson.nativeHeapUsage = generateMemoryObject(memInfoJoined, returnIntArrayForItem('Native Heap', new RegExp('\\bNative Heap\\b\\s{2}'), contentArray));
    memoryJson.dalvikHeapUsage = generateMemoryObject(memInfoJoined, returnIntArrayForItem('Dalvik Heap', new RegExp('\\bDalvik Heap\\b\\s{2}'), contentArray));
    let memoryObjects = returnIntArrayForArrayPairs([['Views', 'ViewRootImpl'], ['AppContexts', 'Activities'], ['Assets', 'AssetManagers'],
        ['Local Binders', 'Proxy Binders'], ['Parcel memory', 'Parcel count'], ['Death Recipients', 'OpenSSL Sockets']], contentArray);
    memoryJson.objects = generateMemoryObject(memoryObjects.strings, memoryObjects.numbers);
    memoryJson.usageUnit = 'kB';
    return memoryJson;
}


function calculateMemoryStats(memoryData) {
    const usageKeys = _.keys(memoryData.usage);
    usageKeys.forEach((key) => {
        let dataArray = memoryData.usage[key].data;
        memoryData.usage[key].max = _.max(dataArray);
        memoryData.usage[key].min = _.min(dataArray);
        memoryData.usage[key].mean = _.round(_.mean(dataArray), 0);
    });
    const nativeHeapUsageKeys = _.keys(memoryData.nativeHeapUsage);
    nativeHeapUsageKeys.forEach((key) => {
        let nativeHeapUsageArray = memoryData.nativeHeapUsage[key].data;
        memoryData.nativeHeapUsage[key].max = _.max(nativeHeapUsageArray);
        memoryData.nativeHeapUsage[key].min = _.min(nativeHeapUsageArray);
        memoryData.nativeHeapUsage[key].mean = _.round(_.mean(nativeHeapUsageArray), 0);
    });
    const dalvikHeapUsageKeys = _.keys(memoryData.dalvikHeapUsage);
    dalvikHeapUsageKeys.forEach((key) => {
        let dalvikHeapUsageArray = memoryData.dalvikHeapUsage[key].data;
        memoryData.dalvikHeapUsage[key].max = _.max(dalvikHeapUsageArray);
        memoryData.dalvikHeapUsage[key].min = _.min(dalvikHeapUsageArray);
        memoryData.dalvikHeapUsage[key].mean = _.round(_.mean(dalvikHeapUsageArray), 0);
    });
    const objectKeys = _.keys(memoryData.objects);
    objectKeys.forEach((key) => {
        let dataArray = memoryData.objects[key].data;
        memoryData.objects[key].max = _.max(dataArray);
        memoryData.objects[key].min = _.min(dataArray);
        memoryData.objects[key].mean = _.round(_.mean(dataArray), 0);
    });
    let upTimeData = memoryData.upTime.data;
    let realTimeData = memoryData.realTime.data;
    memoryData.upTime.start = _.min(upTimeData);
    memoryData.upTime.end = _.max(upTimeData);
    memoryData.upTime.duration = memoryData.upTime.end - memoryData.upTime.start;
    memoryData.realTime.start = _.min(realTimeData);
    memoryData.realTime.end = _.max(realTimeData);
    memoryData.realTime.duration = memoryData.realTime.end - memoryData.realTime.start;
    return memoryData;
}

function processMemoryUsageFromFile(file) {
    // var memoryInfo = {upTimeArray: [], realTimeArray: [], totalPssArray:[], dirtyPrivateArray:[], cleanPrivateArray:[],
    //     dirtySwappedArray:[], sizeHeapArray:[],allocHeapArray:[], freeHeapArray:[]};
    let memoryInfo = {
        upTime: {start: null, duration: null, end: null, data: []},
        realTime: {start: null, duration: null, end: null, data: []},
        usage: {},
        nativeHeapUsage: {},
        dalvikHeapUsage: {},
        objects: {},
        usageUnit: null
    };
    const expectedKeys = ['pssTotal', 'privateDirty', 'privateClean', 'swappedDirty', 'heapSize', 'heapAlloc', 'heapFree'];
    expectedKeys.forEach((key) => {
        memoryInfo.usage[key] = {min: null, max: null, mean: null, data: []};
        memoryInfo.nativeHeapUsage[key] = {min: null, max: null, mean: null, data: []};
        memoryInfo.dalvikHeapUsage[key] = {min: null, max: null, mean: null, data: []};
    });
    const expectedObjectKeys = ['views', 'viewRootImpl', 'appContexts', 'activities', 'assets', 'assetManagers', 'localBinders',
        'proxyBinders', 'parcelmemory', 'parcelcount', 'deathRecipients', 'openSSLSockets'];
    expectedObjectKeys.forEach((key) => {
        memoryInfo.objects[key] = {min: null, max: null, mean: null, data: []};
    });
    return fsPromise
    //TODO node docs say don't do this now, check on file open error instead.
        .access(file, fs.R_OK)
        .then(() => {
            return when.promise((resolve, reject) => {
                let rl = require('readline').createInterface({
                    input: fs.createReadStream(file)
                });
                rl.on('line', function (line) {
                    try {
                        let parsedLine = JSON.parse(line);
                        let usage = parsedLine.usage;
                        let usageKeys = _.keys(usage);
                        let dalvik = parsedLine.dalvikHeapUsage;
                        let dalvikKeys = _.keys(dalvik);
                        let native = parsedLine.nativeHeapUsage;
                        let nativeKeys = _.keys(native);
                        let objects = parsedLine.objects;
                        let objectKeys = _.keys(objects);
                        usageKeys.forEach((key) => {
                            memoryInfo.usage[key].data.push(usage[key]);
                        });
                        dalvikKeys.forEach((key) => {
                            memoryInfo.dalvikHeapUsage[key].data.push(dalvik[key]);
                        });
                        nativeKeys.forEach((key) => {
                            memoryInfo.nativeHeapUsage[key].data.push(native[key]);
                        });
                        objectKeys.forEach((key) => {
                            memoryInfo.objects[key].data.push(objects[key]);
                        });
                        memoryInfo.upTime.data.push(parsedLine.upTime);
                        memoryInfo.realTime.data.push(parsedLine.realTime);
                        if (!memoryInfo.usageUnit) {
                            memoryInfo.usageUnit = parsedLine.usageUnit;
                        }
                    } catch (error) {
                        console.error('Error doing json parse of log line ' + line + ' with error: ' + error);
                        reject('Error doing json parse of log line ' + line + ' with error: ' + error);
                    }
                });
                rl.on('close', function () {
                    resolve(memoryInfo);
                });
                rl.on('error', function (error) {
                    reject(error);
                });
            }).timeout(60000);
        });
}

function getMemoryUsage(adbClient, serial, application) {
    return adbClient.shell(serial, [androidDumpSysCmd, application].join(' '))
        .then(adb.util.readAll)
        .then(function (output) {
            try {
                return formatMemoryUsageText(output.toString().trim());
            } catch (error) {
                debug('Problem processing getMemoryUsage with: ' + error);
                debug('adb output is: Start Output ### ' + JSON.stringify(output.toString().trim()) + ' ### End Output');
                debug('Continuing.... getMemoryUsage for: ' + serial + ',' + application);
                throw new Error('Problem processing getMemoryUsage with: ' + error.message);
            }
        });
}

function getMemoryAndLogToFile(adbClient, serial, fileName, application) {
    getMemoryUsage(adbClient, serial, application)
        .then((adbMemoryUsage) => {
            return updateMemoryFile(fileName, adbMemoryUsage);
        })
        .catch((error) => {
            console.error('Error occured in getMemoryAndLogToFile chain: ' + error);
            if (android.androidDeviceNotFoundRegex.test(error)) {
                return android.restartAdb(adbClient);
            }
        });
}

function startAndroidMemoryLogging(adbClient, device, timeToExpire, application, configOptions) {
    return createLogMemoryLogFile(configOptions.benchmarkDir)
        .then((memoryFile) => {
            debug('Starting setInterval for startAndroidMemoryLogging for device: ' + device + ' and benchmarkId: ' + memoryFile.id +
                ' and polling at: ' + configOptions.benchmarkPollTime);
            var intervalId = setInterval(function () { // TODO this needs to be rewritten as a reccursive setTimeout
                getMemoryAndLogToFile(adbClient, device, memoryFile.path, application);
                if (moment().isAfter(timeToExpire)) {
                    console.error('Timeout reached on startAndroidMemoryLogging so stopping setInterval');
                    clearInterval(intervalId);
                }
            }, configOptions.benchmarkPollTime);
            return {memoryFile, intervalId};
        });
}

function getAndSendHeap(adbClient, serial, application, res) {
    const internalLocation = '/data/local/tmp/app-memory.hprof';
    const command = [androidDumpHeapCmd, application, internalLocation].join(' ');
    debug ('Running getAndSendHeap with: ' + command + ' for device: ' + serial);
    let gzip = zlib.createGzip();
    return (
        when(adbClient.shell(serial, [androidDumpHeapCmd, application, internalLocation].join(' ')))
            .then(adb.util.readAll)
            .then((output) => { debug('output from androidDumpHeapCmd: ' + output.toString().trim()); })
            .delay(1000)
            .then(() => (
                adbClient
                    .pull(serial, internalLocation)
                    .then(pullTransfer => new Promise((resolve, reject) => {
                        pullTransfer.on('error', (error) => { reject(error); });
                        pullTransfer.pipe(gzip).pipe(res);
                        pullTransfer.on('finish', () => { //finish event from stream transform inherited from PullTransfer
                            resolve('Transfer finished for ' + command + ' On device ' + serial);
                        });
                    }))
            ))
            .catch((error) => {
                debug('error in getAndSendHeap' + error);
                res.status(500).json(error);
                throw new Error(error);
            })
    );
}

module.exports.startAndroidMemoryLogging = startAndroidMemoryLogging;
module.exports.processMemoryUsageFromFile = processMemoryUsageFromFile;
module.exports.calculateMemoryStats = calculateMemoryStats;
module.exports.getAndSendHeap = getAndSendHeap;