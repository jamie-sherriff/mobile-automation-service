/**
 * Created by jamie on 20/04/17.
 */
var BLANK_IMG =
    'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

var canvas = document.getElementById('canvas'), canvas2D = canvas.getContext('2d');

function populateDefaults () {
    document.getElementById('connect-text').value =  window.location.hostname || 'localhost';
}

function hideStuff () {
    document.getElementById('connect-div').style.display = 'none';
}

function connectWebSocket () {
    var hostname = document.getElementById('connect-text').value   || location.hostname;
    var ws = new WebSocket('ws://' + hostname + ':9002');
    ws.binaryType = 'blob';

    ws.onclose = function () {
        console.log('onclose', arguments);
    };

    ws.onerror = function () {
        console.log('onerror', arguments);
    };

    ws.onmessage = function (message) {
        var blob = new Blob([message.data], {type: 'image/jpeg'});
        var URL = window.URL || window.webkitURL;
        var img = new Image();
        img.onload = function () {
            canvas.width = img.width;
            canvas.height = img.height;
            //canvas2D.drawImage(img, 0, 0, window.innerWidth, window.innerHeight);
            canvas2D.drawImage(img, 0, 0);
            img.onload = null;
            img.src = BLANK_IMG;
            img = null;
            blob = null;
        };
        img.src = URL.createObjectURL(blob);
    };

    ws.onopen = function () {
        hideStuff();
        console.log('onopen', arguments);
        ws.send('Hello');
    };
}
window.onload = connectWebSocket;