/**
 * Created by jamie on 27/04/17.
 */
'use strict';
const moment = require('moment');
const _ = require('lodash');
const debug = require('debug')('automation:running');
//This needs to incorporate connected devices
let RunningConfig = {
    takeScreenshots: true,
    screenRecordStartTime: null,
    screenshotFrameCount: 0,
};

let RunningConfigObjects = module.exports = {
    devices: {},
    addDeviceToConfig: (deviceSerial) => {
        debug('Added ' + deviceSerial + ' to running');
        RunningConfigObjects.devices[deviceSerial] = _.cloneDeep(RunningConfig);
        return RunningConfigObjects.devices[deviceSerial];
    },
    getDevice: (deviceSerial) => {
        return RunningConfigObjects.devices[deviceSerial] || null;
    },
    startScreenshots: (deviceSerial) => {
        let config = RunningConfigObjects.devices[deviceSerial];
        config.takeScreenshots = true;
        config.screenRecordStartTime = moment().unix();
    },
    stopScreenshots: (deviceSerial) => {
        let config = RunningConfigObjects.devices[deviceSerial];
        config.takeScreenshots = false;
    },

};