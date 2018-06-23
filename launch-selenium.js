/**
 * Created by jamie on 11/02/16.
 */
"use strict";
var selenium = require('selenium-standalone');
var configOptions = require('./helpers/processSeleniumConfig').configOptions;

var seleniumArgsHub = [
    //  '-debug',
    '-port',
    configOptions.seleniumHubPort,
    '-role',
    'hub'
];

var seleniumArgsNode = [
    // '-debug',
    '-port',
    '5400',
    '-role',
    'node',
    '-hub',
    configOptions.seleniumHubUrl+'/register',
    '-browser',
    'browserName=chrome,maxInstances=5'
];


var launchOptionsHub={
    seleniumArgs: seleniumArgsHub,
    version: configOptions.seleniumVersion,
    drivers: {
        chrome: {
            // check for more recent versions of chrome driver here:
            // https://chromedriver.storage.googleapis.com/index.html
            version: configOptions.chromeDriverVersion,
            arch: process.arch,
            baseURL: 'https://chromedriver.storage.googleapis.com'
        }
    }};

var launchOptionsNode={
    seleniumArgs: seleniumArgsNode,
    version: configOptions.seleniumVersion,
    drivers: {
        chrome: {
            // check for more recent versions of chrome driver here:
            // https://chromedriver.storage.googleapis.com/index.html
            version: configOptions.chromeDriverVersion,
            arch: process.arch,
            baseURL: 'https://chromedriver.storage.googleapis.com'
        }
    }};


selenium.install({
    // check for more recent versions of selenium here:
    // https://selenium-release.storage.googleapis.com/index.html
    version: configOptions.seleniumVersion,
    baseURL: 'https://selenium-release.storage.googleapis.com',
    drivers: {
        chrome: {
            // check for more recent versions of chrome driver here:
            // https://chromedriver.storage.googleapis.com/index.html
            version: configOptions.chromeDriverVersion,
            arch: process.arch,
            baseURL: 'https://chromedriver.storage.googleapis.com'
        }
    },
    logger: function(message) {
        console.log(message)
    },
    progressCb: function(totalLength, progressLength, chunkLength) {
        //console.log(totalLength)
        //console.log(progressLength)
        //console.log(chunkLength)
    }
}, function(){
    console.log('Selenium installed');
    selenium.start(launchOptionsHub, function(err, child) {
        console.log(err)

        child.stderr.on('data', function(data){
            console.log(data.toString());
        });
        console.log('hub node launched');
        selenium.start(launchOptionsNode, function(err, child) {
            console.log(err);
            //console.log(child)
            console.log("node 1 launched")
            child.stderr.on('data', function(data){
                console.log(data.toString());
            });
        });

        //selenium.start(launchOptionsNode2, function(err, child) {
        //    console.log(err);
        //    //console.log(child)
        //    console.log("node 2 launched")
        //    child.stderr.on('data', function(data){
        //        console.log(data.toString());
        //    });
        //});

    });

});

//console.log(err)