/**
 * Created by root on 08/04/2015.
 */

var path = require('path');
var noble = require('noble');
var async = require('async');
var Firebase = require('firebase');
var loadConfig = require('./loadConfig.js');
var winston = require('winston');

module.exports = new MainGateway();

function MainGateway() {
    var that = this;
    this.state = 0;
    this.startTime = 0;
    this.peripheralConfigs = {};
    this.connectedPeripherals = [];

    this.firebaseInfo = {};
    this.ref = {};

    this.getStatus = function(callback) {
        var data = {};
        if (that.state === 0) {
            data.status = 'Not running';
            data.uptime = 0;
        }
        else {
            data.status = 'Running';
            data.peripherals = [];
            for (i = 0; i < that.connectedPeripherals.length; i++) {
                data.peripherals[i] = {};
                data.peripherals[i].uuid = that.connectedPeripherals[i].uuid;
                data.peripherals[i].rssi = that.connectedPeripherals[i].rssi;
                data.peripherals[i].advertisement = that.connectedPeripherals[i].advertisement;
            }
            data.uptime = Date.now() - that.startTime;
        }
        callback(data);
    }

    this.init = function(callback) {
        async.series([
                function (callback) {
                    loadConfig.loadPeripherals(function (error, data) {
                        if (error) {
                            winston.log('error',error.toString());
                            return callback(error);
                        }

                        that.peripheralConfigs = data;
                        console.log(that.peripheralConfigs);
                        callback(null, data);
                    });
                },
                function (callback) {
                    loadConfig.loadFirebase(function (error, data) {
                        if (error) {
                            winston.log('error',error.toString());
                            return callback(error);
                        }

                        that.firebaseInfo = data;
                        console.log(data);
                        if(!that.firebaseInfo)
                        {
                            winston.log('error','Cannot load firebase.json');
                            return callback('Cannot load firebase.json');
                        }

                        that.ref = new Firebase(that.firebaseInfo.url);

                        if (that.firebaseInfo.token) {
                            that.ref.authWithCustomToken(that.firebaseInfo.token, function (error, authData) {
                                if (error) {
                                    winston.log('error',error.toString());
                                }
                                else {
                                    console.log(authData);
                                }
                                callback(null, data);
                            });
                        }
                        else if (that.firebaseInfo.username && that.firebaseInfo.password) {
                            var credentials = {
                                username: that.firebaseInfo.username,
                                password: that.firebaseInfo.password
                            };
                            that.ref.authWithPassword(credentials, function (error, authData) {
                                if (error) {
                                    winston.log('error',error.toString());
                                }
                                else {
                                    console.log(authData);
                                }
                                callback(null, data);
                            });
                        }
                        else {
                            callback(null, data);
                        }
                    });
                }
                ,
                function (callback) {

                    noble.on('discover', discoverListener);

                    noble.startScanning([], true); //duplicate scan
                    winston.log('info','Scan started!');

                    that.startTime = Date.now();
                    that.state = 1;
                    callback(null, 'Scan started!');
                }],
            function (err, results) {
                if (err) {
                    callback(err);
                }
                else
                {
                    callback(null,results);
                }
            });
    };

    this.stopGateway = function(callback){
        noble.stopScanning();
        winston.log('info','Scan stopped!');

        that.startTime = 0;
        that.state = 0;
        that.q.tasks.length = 0;
        for (i = 0; i < that.connectedPeripherals.length; i++) {
           that.connectedPeripherals[i].disconnect();
        }
        that.connectedPeripherals.length = 0;
        noble.removeListener('discover',discoverListener);
        callback();
    }

    var discoverListener = function (peripheral) {
        //console.log(that.peripheralConfigs);
        for (var k in that.peripheralConfigs) {
            if (peripheral.uuid === k && peripheral.state === 'disconnected') {
                that.q.push(peripheral);
            }
        }
    }


    this.connectPeripheral = function (peripheral, cb) {

        var usingUuids = {};
        var peripheralInfo = this.peripheralConfigs[peripheral.uuid];
        var characteristicsProperties = {};

        for (i = 0; i < peripheralInfo.length; i++) {
            if (peripheralInfo[i].characteristics) {
                for (j = 0; j < peripheralInfo[i].characteristics.length; j++) {
                    if (peripheralInfo[i].characteristics[j].read || peripheralInfo[i].characteristics[j].write) {
                        if (!usingUuids[peripheralInfo[i].uuid]) {
                            usingUuids[peripheralInfo[i].uuid] = [];
                        }
                        usingUuids[peripheralInfo[i].uuid].push(peripheralInfo[i].characteristics[j].uuid);

                        if (!characteristicsProperties[peripheralInfo[i].characteristics[j].uuid])
                            characteristicsProperties[peripheralInfo[i].characteristics[j].uuid] = {};

                        if (peripheralInfo[i].characteristics[j].read) {
                            if (peripheralInfo[i].characteristics[j].notify) {
                                characteristicsProperties[peripheralInfo[i].characteristics[j].uuid].notify = true;
                            }
                            characteristicsProperties[peripheralInfo[i].characteristics[j].uuid].read = true;
                        }

                        if (peripheralInfo[i].characteristics[j].write) {
                            characteristicsProperties[peripheralInfo[i].characteristics[j].uuid].write = peripheralInfo[i].characteristics[j].write;
                        }
                    }
                }
            }
        }

        peripheral.connect(function (error) {
            winston.log('info','on -> connect to ' + peripheral.uuid);

            peripheral.once('disconnect', function () {
                winston.log(peripheral.uuid + ' disconnected');

                for (i = 0; i < that.connectedPeripherals.length; i++) {
                    if (that.connectedPeripherals[i].uuid === peripheral.uuid) {
                        that.connectedPeripherals.splice(i, 1);
                        console.log(that.connectedPeripherals.length);
                    }
                }

                console.log(that.q.tasks);
            });

            if (error) {
                winston.log('error',error.toString());
                return cb(error);
            }
            else {

                that.connectedPeripherals.push(peripheral);
                console.log(that.connectedPeripherals.length);
                var usingServiceUuids = Object.keys(usingUuids);

                peripheral.discoverServices(usingServiceUuids, function (error, services) {
                    console.log('SERVICES');

                    if (error) {
                        winston.log('error',error.toString());
                        //cb(error);
                    }
                    else {
                        var serviceIndex = 0;

                        async.whilst(
                            function () {
                                return (serviceIndex < services.length);
                            }
                            ,
                            function (callback) {
                                var usingCharacteristicUuids = usingUuids[services[serviceIndex].uuid];
                                services[serviceIndex].discoverCharacteristics(usingCharacteristicUuids, function (error, characteristics) {

                                    if (error) {
                                        winston.log('error',error.toString());
                                        serviceIndex = services.length;
                                        callback();
                                    }

                                    var characteristicIndex = 0;
                                    async.whilst(
                                        function () {
                                            return (characteristicIndex < characteristics.length);
                                        }
                                        ,
                                        function (callback) {
                                            if (characteristicsProperties[characteristics[characteristicIndex].uuid].write) {
                                                var writeData = characteristicsProperties[characteristics[characteristicIndex].uuid].write;
                                                console.log(writeData);
                                                if(writeData[0] != 0)
                                                {
                                                    writeData = '0' + writeData;
                                                }
                                                var writeDataBuffer = new Buffer(writeData,'hex');

                                                characteristics[characteristicIndex].write(new Buffer(writeData, 'hex'), false);
                                            }

                                            if (characteristicsProperties[characteristics[characteristicIndex].uuid].read) {
                                                var serviceUuid = services[serviceIndex].uuid;
                                                var characteristicUuid = characteristics[characteristicIndex].uuid;
                                                characteristics[characteristicIndex].on('read', function (data, isNotification) {
                                                    //FB upload
                                                    that.ref.child(peripheral.uuid).child(serviceUuid).child(characteristicUuid).push({
                                                        data: data.toString('hex'),
                                                        time: Date.now()
                                                    });

                                                    console.log('read data');
                                                    console.log(data);
                                                });

                                                characteristics[characteristicIndex].read();

                                                if (characteristicsProperties[characteristics[characteristicIndex].uuid].notify) {
                                                    characteristics[characteristicIndex].notify(true, function (error) {
                                                        if(error)
                                                            winston.log('error',error.toString());
                                                    });
                                                    console.log('notify');
                                                }
                                            }

                                            characteristicIndex++;
                                            callback();
                                        },
                                        function (error) {
                                            serviceIndex++;
                                            callback();
                                        }
                                    );
                                });

                            },
                            function (error) {
                                if (error)
                                    console.log(error);
                                //cb();
                            }
                        );
                    }
                });
                cb();
            }

        });
    }

    this.q = async.queue(
        function (task, callback) {
            if (task) {
                that.connectPeripheral(task, function (error) {
                    if (error) {
                        console.log(error);
                    }
                    callback();
                });
            }
            else
                callback();
            //setTimeout(next(), 5000);
        }, 1);

}
