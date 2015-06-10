/**
 * Created by root on 30/03/2015.
 */

var Hapi = require('hapi');
var path = require('path');
var noble = require('noble');
var fs = require('fs');
var loadConfig = require('./loadConfig.js');
var Bcrypt = require('bcrypt');
var Basic = require('hapi-auth-basic');
var MainGateway = require('./gateway.js');
var winston = require('winston');
var ServerAPI = require('./server-api.js');

var PORT = 8081;

fs.writeFile(__dirname + "/log/" + "server.log", '', function (err) {
    if (err) {
        winston.log('error',error.toString());
    }
    winston.add(winston.transports.File, { filename: 'log/server.log' });
});

var route = [{
    method: "GET"
    , path: '/'
    , config: {
        auth: 'simple',
        handler: function (request, reply) {
            reply.file('home.html');
        }
    }
}, {
    method: "GET"
    , path: '/index.html'
    , config: {
        auth: 'simple',
        handler: function (request, reply) {
            MainGateway.getStatus(function (data) {
                if (data) {
                    console.log(data.status);
                    if (data.status === 'Running') {
                        reply.redirect('home.html');
                    }
                    else {
                        reply.file('index.html');
                    }
                }
                else {
                    reply('Error');
                }
            });
        }
    }
},{
    method: 'GET',
    path: '/{path*}',
    config: {
        auth: 'simple',
        handler: {
            directory: {path: './', listing: false, index: true}
        }
    }
}, {
    method: "GET"
    , path: '/api/peripheral'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getPeripheral
    }
}, {
    method: "POST"
    , path: '/api/allInfo'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getAllInfo
    }
}, {
    method: "POST"
    , path: '/api/services'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getAllServices
    }
}, {
    method: "POST"
    , path: '/api/characteristics'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getAllCharacteristics
    }
}, {
    method: "POST"
    , path: '/api/descriptors'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getAllDescriptors
    }
}, {
    method: "POST"
    , path: '/api/data/characteristic'
    , config: {
        auth: 'simple',
        handler: ServerAPI.readCharacteristicData
    }
}, {
    method: "POST"
    , path: '/api/data/descriptor'
    , config: {
        auth: 'simple',
        handler: ServerAPI.readDescriptorData
    }
}, {
    method: "POST"
    , path: '/api/disconnect'
    , config: {
        auth: 'simple',
        handler: ServerAPI.disconnectPeripheral
    }
}, {
    method: "POST"
    , path: '/api/save/peripheral'
    , config: {
        auth: 'simple',
        handler: ServerAPI.saveConfig
    }
}, {
    method: "GET"
    , path: '/api/firebase'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getFirebaseConfig
    }
}, {
    method: "GET"
    , path: '/api/gateway/start'
    , config: {
        auth: 'simple',
        handler: ServerAPI.startGateway
    }
}, {
    method: "GET"
    , path: '/api/gateway/stop'
    , config: {
        auth: 'simple',
        handler: ServerAPI.stopGateway
    }
}, {
    method: "GET"
    , path: '/api/gateway/getStatus'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getGatewayStatus
    }
}, {
    method: "POST"
    , path: '/api/save/firebase'
    , config: {
        auth: 'simple',
        handler: ServerAPI.saveFirebaseConfig
    }
}, {
    method: "POST"
    , path: '/api/gateway/admin'
    , config: {
        auth: 'simple',
        handler: ServerAPI.changeAdminPassword
    }
}, {
    method: "GET"
    , path: '/api/gateway/peripheralConfigList'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getPeripheralConfigList
    }
}, {
    method: "POST"
    , path: '/api/gateway/peripheralConfig'
    , config: {
        auth: 'simple',
        handler: ServerAPI.getPeripheralConfig
    }
}, {
    method: "POST"
    , path: '/api/gateway/deletePeripheralConfig'
    , config: {
        auth: 'simple',
        handler: ServerAPI.deletePeripheral
    }
}];

var server = new Hapi.Server({
    connections: {
        routes: {
            cors: true
        }
    }
});
server.connection({port: PORT});

/*var pages = {
 '/': 'home.html'
 }

 for (var k in pages) {
 server.route({
 method: "GET"
 , path: k
 , handler: function (request, reply) {
 var resp = pages[k];
 reply.file(resp);
 }
 });
 }*/

//Start main gateway
MainGateway.init(function (error) {
    if(error)
    {
        return winston.log('error',error.toString());
    }
    winston.log('info','Gateway Started!');
});


//Start web server with authentication
server.register(Basic, function (err) {
    var validate = function (username, password, callback) {
        loadConfig.loadLogin(function (error, data) {
            if (!data || error) {
                if (username === 'admin' && password === 'admin')
                    return callback(null, true, {id: 'admin', name: 'admin'});
                else
                    return callback(null, false);
            }

            if (data.password && username === 'admin') {
                Bcrypt.compare(password, data.password, function (err, isValid) {
                    callback(err, isValid, {id: 'admin', name: 'admin'});
                });
            }
            else
                callback(null, false);
        });
    };

    server.auth.strategy('simple', 'basic', {validateFunc: validate});

    // Serve static files from `static` dir.
    server.route(route);

    server.start(function () {
        winston.log('info','Website started on ' + server.info.uri);
    });

});

