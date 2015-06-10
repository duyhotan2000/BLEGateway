/**
 * Created by root on 05/06/2015.
 */
var path = require('path');
var noble = require('noble');
var Boom = require('boom');
var fs = require('fs');
var loadConfig = require('./loadConfig.js');
var async = require('async');
var Bcrypt = require('bcrypt');
var winston = require('winston');
var MainGateway = require('./gateway.js');

module.exports = new ServerAPI();

function ServerAPI() {
    var that = this;
    var connectedperipherals = [];
    var scannedperipherals = [];

    this.getGatewayStatus = function (request, reply) {
        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        MainGateway.getStatus(function (data) {
            if (data) {
                data = JSON.stringify(data);
                console.log(data);
                reply(data);
            }
            else {
                errorHandler('No info');
            }
        });
    }

    this.startGateway = function (request, reply) {
        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        MainGateway.init(function (error, results) {
            if (error) {
                errorHandler(error);
            }
            else {
                reply(results);
            }
        });
    }

    this.stopGateway = function (request, reply) {
        MainGateway.stopGateway(function () {
            winston.log('info','Gateway Stopped');
            reply('Stop success!');
        });
    }

    this.getPeripheral = function (request, reply) {

        for (i = 0; i < connectedperipherals.length; i++) {
            if (connectedperipherals[i]) {
                connectedperipherals[i].disconnect();
                console.log(connectedperipherals[i]);
            }
        }

        var peripherals = [];
        scannedperipherals = [];
        connectedperipherals = [];

        //noble.stopScanning();
        noble.startScanning([], false);

        noble.on('scanStart', function () {
            winston.log('info','on -> scanStart');
        });

        noble.on('scanStop', function () {
            winston.log('info','on -> scanStop');
        });

        var peripheralReply = function () {
            noble.removeAllListeners('discover');
            noble.stopScanning();
            var peripheralsJSON = JSON.stringify(peripherals);
            reply(peripheralsJSON);
        }

        setTimeout(peripheralReply, 10000);

        noble.on('discover', function (peripheral) {
            console.log('on -> discover: ' + peripheral);
            var temp = {
                uuid: peripheral.uuid,
                name: peripheral.advertisement.localName
            };
            peripherals.push(temp);
            scannedperipherals.push(peripheral);
        });
    }

    this.getAllInfo = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;
        console.log(peripheralUuid);

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < scannedperipherals.length; i++) {
            if (peripheralUuid === scannedperipherals[i].uuid) {
                peripheral = scannedperipherals[i];
            }
        }

        if (peripheral) {
            console.log(peripheral);
            var replyObj = [];

            peripheral.connect(function (error) {
                console.log('on -> connect');
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    connectedperipherals.push(peripheral);
                    peripheral.discoverServices([], function (error, services) {

                        if (error) {
                            console.log(error);
                            errorHandler(error);
                        }
                        else {

                            var serviceIndex = 0;
                            async.whilst(function () {
                                    return (serviceIndex < services.length);
                                }, function (callback) {
                                    var servicesObj = {uuid: null, name: null, type: null, includedServiceUuids: null};
                                    if (services[serviceIndex].uuid)
                                        servicesObj.uuid = services[serviceIndex].uuid;
                                    if (services[serviceIndex].name)
                                        servicesObj.name = services[serviceIndex].name;
                                    if (services[serviceIndex].type)
                                        servicesObj.type = services[serviceIndex].type;
                                    if (services[serviceIndex].includedServiceUuids)
                                        servicesObj.includedServiceUuids = services[serviceIndex].includedServiceUuids;
                                    servicesObj.characteristics = [];
                                    replyObj.push(servicesObj);

                                    services[serviceIndex].discoverCharacteristics([], function (error, characteristics) {

                                        if (error) {
                                            console.log(error);
                                            //serviceIndex = services.length;
                                            callback(error);
                                        }

                                        var characteristicIndex = 0;
                                        async.whilst(
                                            function () {
                                                return (characteristicIndex < characteristics.length);
                                            }
                                            ,
                                            function (callback) {
                                                var characteristicsObj = {
                                                    uuid: null,
                                                    name: null,
                                                    type: null,
                                                    properties: null
                                                };
                                                if (characteristics[characteristicIndex].uuid)
                                                    characteristicsObj.uuid = characteristics[characteristicIndex].uuid;
                                                if (characteristics[characteristicIndex].name)
                                                    characteristicsObj.name = characteristics[characteristicIndex].name;
                                                if (characteristics[characteristicIndex].type)
                                                    characteristicsObj.type = characteristics[characteristicIndex].type;
                                                if (characteristics[characteristicIndex].properties)
                                                    characteristicsObj.properties = characteristics[characteristicIndex].properties;
                                                characteristicsObj.descriptors = [];
                                                replyObj[serviceIndex].characteristics.push(characteristicsObj);

                                                characteristics[characteristicIndex].discoverDescriptors(function (error, descriptors) {
                                                    if (error) {
                                                        callback(error);
                                                    }
                                                    else {

                                                        for (i = 0; i < descriptors.length; i++) {
                                                            var temp = {uuid: null, name: null, type: null};

                                                            if (descriptors[i].uuid)
                                                                temp.uuid = descriptors[i].uuid;
                                                            if (descriptors[i].name)
                                                                temp.name = descriptors[i].name;
                                                            if (descriptors[i].type)
                                                                temp.type = descriptors[i].type;
                                                            replyObj[serviceIndex].characteristics[characteristicIndex].descriptors.push(temp);
                                                        }

                                                    }
                                                    characteristicIndex++;
                                                    callback();
                                                });
                                            }
                                            ,
                                            function (error) {
                                                if (error) {
                                                    callback(error);
                                                }
                                                serviceIndex++;
                                                callback();
                                            });
                                    });
                                }, function (error) {
                                    if (error) {
                                        console.log(error);
                                        errorHandler(error);
                                    }
                                    else {
                                        console.log(replyObj);
                                        reply(replyObj);
                                    }
                                }
                            );

                        }

                    });
                }
            });
        }
    }


    this.getAllServices = function (request, reply) { //connect already scanned device
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < scannedperipherals.length; i++) {
            if (peripheralUuid === scannedperipherals[i].uuid) {
                peripheral = scannedperipherals[i];
            }
        }

        if (peripheral) {
            console.log(peripheral);
            peripheral.connect(function (error) {
                console.log('on -> connect');
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    //this.updateRssi();
                    connectedperipherals.push(peripheral);
                    peripheral.discoverServices([], function (error, services) {
                        if (error) {
                            console.log(error);
                            errorHandler(error);
                        }
                        else {
                            var servicesObj = [];

                            for (i = 0; i < services.length; i++) {
                                var temp = {uuid: null, name: null, name: null, includedServiceUuids: null};

                                if (services[i].uuid)
                                    temp.uuid = services[i].uuid;
                                if (services[i].name)
                                    temp.name = services[i].name;
                                if (services[i].type)
                                    temp.type = services[i].type;
                                if (services[i].includedServiceUuids)
                                    temp.includedServiceUuids = services[i].includedServiceUuids;
                                servicesObj.push(temp);
                            }
                            console.log(servicesObj);
                            reply(servicesObj);
                        }

                    });
                }
            });

            peripheral.once('disconnect', function () {
                console.log('disconnect ' + peripheral.uuid);
                winston.log('info','Disconnect ' + peripheral.uuid);
                for (i = 0; i < connectedperipherals.length; i++) {
                    if (peripheral.uuid === connectedperipherals[i].uuid)
                        connectedperipherals.splice(i, 1);
                }
            });
        }
    }

    this.getAllCharacteristics = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;
        var serviceUuid = payload.service;
        console.log(serviceUuid);

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < connectedperipherals.length; i++) {
            if (peripheralUuid === connectedperipherals[i].uuid)
                peripheral = connectedperipherals[i];
        }

        if (peripheral) {
            peripheral.discoverServices([serviceUuid], function (error, services) {
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    services[0].discoverCharacteristics([], function (error, characteristics) {
                        if (error) {
                            console.log(error);
                            errorHandler(error);
                        }
                        else {
                            var characteristicsObj = [];

                            for (i = 0; i < characteristics.length; i++) {
                                var temp = {uuid: null, name: null, type: null, properties: null};

                                if (characteristics[i].uuid)
                                    temp.uuid = characteristics[i].uuid;
                                if (characteristics[i].name)
                                    temp.name = characteristics[i].name;
                                if (characteristics[i].type)
                                    temp.type = characteristics[i].type;
                                if (characteristics[i].properties)
                                    temp.properties = characteristics[i].properties;
                                characteristicsObj.push(temp);
                            }
                            console.log(characteristicsObj);
                            reply(characteristicsObj);
                        }

                    });
                }
            });
        }
    }

    this.getAllDescriptors = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;
        var serviceUuid = payload.service;
        var characteristicUuid = payload.characteristic;
        console.log(characteristicUuid);

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < connectedperipherals.length; i++) {
            if (peripheralUuid === connectedperipherals[i].uuid)
                peripheral = connectedperipherals[i];
        }

        if (peripheral) {
            peripheral.discoverServices([serviceUuid], function (error, services) {
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    services[0].discoverCharacteristics([characteristicUuid], function (error, characteristics) {
                        if (error) {
                            console.log(error);
                            errorHandler();
                        }
                        else {
                            characteristics[0].discoverDescriptors(function (error, descriptors) {
                                if (error) {
                                    errorHandler(error);
                                }
                                else {
                                    var descriptorsObj = [];

                                    for (i = 0; i < descriptors.length; i++) {
                                        var temp = {uuid: null, name: null, type: null};

                                        if (descriptors[i].uuid)
                                            temp.uuid = descriptors[i].uuid;
                                        if (descriptors[i].name)
                                            temp.name = descriptors[i].name;
                                        if (descriptors[i].type)
                                            temp.type = descriptors[i].type;
                                        descriptorsObj.push(temp);
                                    }
                                    console.log(descriptorsObj);
                                    reply(descriptorsObj);
                                }

                            });
                        }
                    });

                }
            })
        }
    }

    this.readCharacteristicData = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;
        var serviceUuid = payload.service;
        var characteristicUuid = payload.characteristic;
        console.log(characteristicUuid);

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < connectedperipherals.length; i++) {
            if (peripheralUuid === connectedperipherals[i].uuid)
                peripheral = connectedperipherals[i];
        }

        if (peripheral) {
            peripheral.discoverServices([serviceUuid], function (error, services) {
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    services[0].discoverCharacteristics([characteristicUuid], function (error, characteristics) {
                        if (error) {
                            console.log(error);
                            errorHandler(error);
                        }
                        else {
                            characteristics[0].read(function (error, data) {
                                if (error) {
                                    console.log(error);
                                    errorHandler(error);
                                }
                                else {
                                    console.log(data.toString('hex'));
                                    reply(data.toString('hex'));
                                }
                            });
                        }
                    });
                }
            });
        }
    }

    this.readDescriptorData = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;
        var serviceUuid = payload.service;
        var characteristicUuid = payload.characteristic;
        var descriptorUuid = payload.descriptor;
        console.log(characteristicUuid);

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < connectedperipherals.length; i++) {
            if (peripheralUuid === connectedperipherals[i].uuid)
                peripheral = connectedperipherals[i];
        }

        if (peripheral) {
            peripheral.discoverServices([serviceUuid], function (error, services) {
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    services[0].discoverCharacteristics([characteristicUuid], function (error, characteristics) {
                        if (error) {
                            console.log(error);
                            errorHandler(error);
                        }
                        else {
                            characteristics[0].discoverDescriptors(function (error, descriptors) {

                                descriptors[0].readValue(function (error, data) {
                                    if (error) {
                                        console.log(error);
                                        errorHandler(error);
                                    }
                                    else {
                                        console.log(data.toString('hex'));
                                        reply(data.toString('hex'));
                                    }
                                });
                            });
                        }
                    });
                }
            });
        }
    }

    this.disconnectPeripheral = function (request, reply) {
        var payload = request.payload;
        console.log(payload);
        //var payloadJSON = JSON.parse(payload);
        var peripheralUuid = payload.peripheral;

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        var peripheral;
        for (i = 0; i < connectedperipherals.length; i++) {
            if (peripheralUuid === connectedperipherals[i].uuid)
                peripheral = connectedperipherals[i];
        }

        if (peripheral) {
            peripheral.disconnect(function (error) {
                if (error) {
                    console.log(error);
                    errorHandler(error);
                }
                else {
                    console.log('Disconnected ' + peripheral.uuid);
                    reply('OK');
                }
            });
        }
    }

    this.saveConfig = function (request, reply) {
        var dir = __dirname + '/config/peripheral/';
        ensureExists(dir, 0744, function (error) {
            if (error) {
                return errorHandler(error);
            }

            var payload = request.payload;
            console.log(payload);
            var peripheralUuid = payload.peripheral;
            var data = payload.data;

            var errorHandler = function (error) {
                var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
                winston.log('error',error);
                reply(errorBoom);
            }

            if (peripheralUuid && data) {

                for (i = 0; i < data.length; i++) {
                    for (j = 0; j < data[i].length; j++) {
                        delete data[i][j]['properties'];
                        delete data[i][j]['data'];
                    }
                }

                fs.writeFile(__dirname + "/config/peripheral/" + peripheralUuid + ".json", JSON.stringify(data), function (err) {
                    if (err) {
                        console.log(err);
                        return errorHandler(err);
                    }
                    console.log("The file was saved!");
                    reply("Success!");
                });
            }
            else
            {
                errorHandler('No data');
            }
        });
    }

    this.getFirebaseConfig = function (request, reply) {
        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        loadConfig.loadFirebase(function (error, data) {
            if (error) {
                console.log(error);
                return errorHandler(error);
            }

            reply(data);
        });
    }

    this.saveFirebaseConfig = function (request, reply) {
        var dir = __dirname + '/config/firebase/';
        ensureExists(dir, 0744, function (error) {
            if (error) {
                console.log(error);
                return errorHandler(error);
            }

            var payload = request.payload;

            var errorHandler = function (error) {
                var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
                winston.log('error',error);
                reply(errorBoom);
            }

            if (payload) {

                fs.writeFile(__dirname + "/config/firebase/firebase.json", JSON.stringify(payload), function (err) {
                    if (err) {
                        console.log(err);
                        return errorHandler(err);
                    }
                    console.log("The file was saved!");
                    reply("Success!");
                });
            }
        });
    }

    this.changeAdminPassword = function (request, reply) {
        var payload = request.payload;

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        if (payload) {
            var oldPassword = payload.oldpassword;
            var newPassword = payload.newpassword;
            var confirmPassword = payload.confirmpassword;

            console.log(payload);
            if (oldPassword && newPassword && confirmPassword) {
                loadConfig.loadLogin(function (error, data) {
                    if (error) {
                        console.log(error);
                        return errorHandler(error);
                    }


                    Bcrypt.compare(oldPassword, data.password, function (err, isValid) {
                        if (err) {
                            console.log(error);
                            return errorHandler(error);
                        }

                        if (!isValid) {
                            return reply('Invalid password');
                        }

                        if (newPassword != confirmPassword) {
                            return reply('Confirm password not match');
                        }

                        var dir = __dirname + '/config/firebase/';
                        ensureExists(dir, 0744, function (error) {
                            if (error) {
                                console.log(error);
                                return errorHandler(error);
                            }

                            var writeData = {};

                            Bcrypt.hash(newPassword, 8, function (err, hash) {
                                if (err) {
                                    return errorHandler(err);
                                }

                                writeData.password = hash;
                                fs.writeFile(__dirname + "/config/login/login.json", JSON.stringify(writeData), function (err) {
                                    if (err) {
                                        console.log(err);
                                        return errorHandler(err);
                                    }
                                    console.log("The file was saved!");

                                    reply("Success!");
                                });
                            });


                        });
                    });
                });
            }
            else {
                return reply('Please fill all fields!');
            }
        }
        else {
            return errorHandler(error);
        }
    }

    this.getPeripheralConfigList = function (request, reply)
    {
        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        loadConfig.loadPeripheralList(function(error,data){
            if(error)
            {
                return errorHandler(error);
            }

            console.log(data);
            reply(data);
        });
    }

    this.getPeripheralConfig = function (request, reply)
    {
        var payload = request.payload;
        var peripheralUuid;

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        if(payload)
        {
            peripheralUuid = payload.uuid;
        }

        loadConfig.loadPeripheral(peripheralUuid,function(error,data){
            if(error)
            {
                return errorHandler(error);
            }

            console.log(data);
            reply(data);
        });
    }

    this.deletePeripheral = function (request, reply)
    {
        var payload = request.payload;
        var peripheralUuid;

        var errorHandler = function (error) {
            var errorBoom = Boom.create(500, error, {timestamp: Date.now()});
            winston.log('error',error);
            reply(errorBoom);
        }

        if(payload)
        {
            peripheralUuid = payload.uuid;
        }

        loadConfig.deletePeripheral(peripheralUuid,function(error){
            if(error)
            {
                return errorHandler(error);
            }

            reply('Peripheral configuration deleted!');
        });
    }

    function ensureExists(path, mask, cb) {
        if (typeof mask == 'function') { // allow the `mask` parameter to be optional
            cb = mask;
            mask = 0777;
        }
        fs.mkdir(path, mask, function (err) {
            if (err) {
                if (err.code == 'EEXIST') cb(null); // ignore the error if the folder already exists
                else cb(err); // something else went wrong
            } else cb(null); // successfully created folder
        });
    }
}