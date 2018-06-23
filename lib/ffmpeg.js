/**
 * Created by jamie on 12/04/17.
 */
'use strict';
//  ffmpeg -framerate 5 -i e1ead3f805564759/%05d.jpg -crf 30 -tune animation output8.mp4
const debug = require('debug')('automation:device-server:ffmpeg');
const path = require('path');
const when = require('when');
const _ = require('lodash');
const whenNode = require('when/node');
const fsPromise = whenNode.liftAll(require('fs-extra'));

/*Assumes when videoOptions are passed in the user will specify all options*/
module.exports.createVideoFromFramesSave = function (wildcard, dirToSearch, outputFile, options = {}) {
    const defaultVideoOptions = _.clone({fps: 10, crf: '30'});
    const videoOptions = _.merge(defaultVideoOptions, options);
    debug('Creating video at: ' + outputFile + ' with options: ' + JSON.stringify(videoOptions));
    return fsPromise.ensureFile(path.resolve(outputFile))
        .then(() => {
            return when.promise((resolve, reject) => {
                let ffmpeg = require('fluent-ffmpeg');
                let videoCommand = ffmpeg(path.join(dirToSearch, wildcard))
                    .inputFPS(videoOptions.fps) // api for fps is an alias for outputFps only
                    .outputFPS(videoOptions.fps)
                    .noAudio()
                    .addOption('-crf', videoOptions.crf)
                    .addOption('-tune', 'animation')
                    .format('mp4')
                    .videoCodec('libx264')
                    .on('start', (commandLine) => {
                        debug('Spawned Ffmpeg with command: ' + commandLine);
                    })
                    .on('codecData', (data) => {
                        debug(data);
                        debug('Input is ' + data.audio + ' audio ' +
                            'with ' + data.video + ' video');
                    })
                    .on('progress', (progress) => {
                        debug('Processing: ' + progress.percent + '% done');
                    })
                    .on('end', () => {
                        resolve(outputFile);
                        debug('Finished processing');
                    })
                    .on('error', (error) => {
                        debug('ffmpeg event error: ' + error.message);
                        reject('ffmpeg event error: ' + error);
                    })
                    .save(outputFile);

                setTimeout(() => {
                    videoCommand.kill();
                }, 280000);// 4.6 minutes
            });
        });
};