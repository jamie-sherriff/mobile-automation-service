/**
 * Created by jamie on 12/12/17.
 */
'use strict';

const emulator = require('./android-emulator');
const path = require('path');
const fs = require('fs-extra');
const when = require('when');
const whenPoll = require('when/poll');
const whenNode = require('when/node');
const promisedXml2js = whenNode.liftAll(require('xml2js'));
const _ = require('lodash');
const debug = require('debug')('automation:server:route-simulation');
const routesFolder = (path.join(__dirname, 'routes'));
const moment = require('moment');

function convertToLocationPoint(string) {
	const formatted = string.split(' ');
	return {lon: _.toNumber(formatted[0]), lat: _.toNumber(formatted[1]), altitude: _.toNumber(formatted[2])};
}

function getLocationDataArray(xmlSource, xmlParseOptions) {
	return promisedXml2js
		.parseString(xmlSource, xmlParseOptions)
		.then((parsedString) => {
			return {
				locationArray: parsedString.kml.Document.Folder.Placemark['1']['gx:MultiTrack']['gx:Track']['gx:coord'],
				format: 'Longitude Latitude Altitude'
			};
		}).then((locationData) => {
			locationData.locationArray = _.map(locationData.locationArray, (item) => {
				return convertToLocationPoint(item);
			});
			return locationData;
		});
}

function sendLocation(device, location) {
	debug(location);
	const lat = _.toString(location.lat);
	const lon = _.toString(location.lon);
	const alt = _.toString(location.altitude);
	const numSats = _.toString(_.random(5, 10));
	return emulator.setLocation(lon, lat, alt, numSats, device.port);
}


function startLocationPoll(device, locationsList, timeToStop, pollTime, inReverse = false) {
	const locationListLength = locationsList.length;
	let index;
	if (inReverse) {
		debug(`Doing startLocationPoll in reverse`);
		index = locationListLength - 1;
	} else {
		index = 0;
	}
	debug(`startLocationPoll for device: ${JSON.stringify(device)} with listLength of ${locationListLength} with pollTime: ${pollTime}`);
	return whenPoll(function () {
		if (inReverse) {
			index -= 1;
		} else {
			index += 1;
		}
		return sendLocation(device, locationsList[index]);
	}, pollTime, () => {
		let finished;
		if (inReverse) {
			finished = index < 1;
		} else {
			finished = index >= locationListLength - 1;
		}
		if (finished) {
			debug(`startLocationPoll finished for ${JSON.stringify(device)}`);
		}
		return moment().isAfter(timeToStop) || finished;
	});
}

async function loopSendLocation(device, locationsList, timeToStop, pollTime) {
	return when.iterate(async function (iteration) {
		debug(`Starting loopSendLocation with iteration: ${iteration}`);
		await startLocationPoll(device, locationsList, timeToStop, pollTime);
		await startLocationPoll(device, locationsList, timeToStop, pollTime, true);
		return iteration + 1;
	}, function () {
		return moment().isAfter(timeToStop);
	}, function (iteration) {
		debug(`loopSendLocation stopped at: ${moment().toISOString()} finished after ${iteration} iterations`);
	}, 0)
		.done();
}


function androidSimulateLocationRoute(device, simulateOptions, configOptions) {
	let {fileName, sendLocationIntervalMs, timeToRunMins} = simulateOptions;
	const timeToStop = moment().add(timeToRunMins, 'minutes');
	const filePath = path.resolve(routesFolder, fileName);
	debug(`simulateLocationRoute finding file at ${filePath} until ${timeToStop.toISOString()}`);
	const xmlParseOptions = {async: true, normalize: true, trim: true, stripPrefix: true, explicitArray: false};
	sendLocationIntervalMs = sendLocationIntervalMs || configOptions.routeSimulationPollTimeMs;
	return fs
		.readFile(filePath, 'utf8')
		.then((fileData) => {
			return getLocationDataArray(fileData, xmlParseOptions);
		}).then((locationData) => {
			loopSendLocation(device, locationData.locationArray, timeToStop, sendLocationIntervalMs);
			return {
				status: 'in-use',
				message: `simulateLocationRoute started for ${JSON.stringify(device)} using file: ${fileName}`,
				device: device
			};
		});
}

module.exports.androidSimulateLocationRoute = androidSimulateLocationRoute;