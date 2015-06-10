/**
 * Created by root on 08/04/2015.
 */
var fs = require('fs');

module.exports = new loadConfig();

function loadConfig() {
    this.ensureExists = function (path, mask, cb) {
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

/*function ensureExists(path, mask, cb) {
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
 }*/

loadConfig.prototype.loadPeripheralList = function (callback) {
    var peripheralDir = __dirname + '/config/peripheral/';
    this.ensureExists(peripheralDir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.readdir(peripheralDir, function (err, files) {
            if (err) {
                return callback(error);
            }
            console.log(files);

            var peripheralUuids = [];
            for(i=0 ; i<files.length ; i++)
            {
                peripheralUuids.push(files[i].substring(0,files[0].length-5));
            }

            callback(null,peripheralUuids);
        });
    });
}

loadConfig.prototype.loadPeripheral = function (peripheralUuid,callback) {
    var peripheralDir = __dirname + '/config/peripheral/';
    this.ensureExists(peripheralDir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.readFile(peripheralDir + peripheralUuid + '.json', 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }

            callback(null, JSON.parse(data));
        })
    });
}

//Delete peripheral config
loadConfig.prototype.deletePeripheral = function (peripheralUuid,callback) {
    var peripheralDir = __dirname + '/config/peripheral/';
    this.ensureExists(peripheralDir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.unlink(peripheralDir + peripheralUuid + '.json', function (err) {
            if (err) {
                return callback(err);
            }

            callback(null);
        })
    });
}


loadConfig.prototype.loadPeripherals = function (callback) {
    var peripheralDir = __dirname + '/config/peripheral/';
    this.ensureExists(peripheralDir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.readdir(peripheralDir, function (err, files) {
            if (err) {
                return callback(error);
            }

            var tempData = {};
            for (i = 0; i < files.length; i++) {
                var obj;
                var filename;
                var data = fs.readFileSync(peripheralDir + files[i], 'utf8');
                try {
                    obj = JSON.parse(data);
                    filename = files[i].substring(0, files[i].lastIndexOf('.'));
                    tempData[filename] = obj;
                }
                catch (e) {
                    return callback(e);
                }
            }
            callback(null, tempData);
        });
    });
}

loadConfig.prototype.loadFirebase = function (callback) {
    var firebaseDir = __dirname + '/config/firebase/';
    this.ensureExists(firebaseDir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.readFile(firebaseDir + 'firebase.json', 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }

            callback(null, JSON.parse(data));
        })
    });
}

loadConfig.prototype.loadLogin =  function (callback)
{
    var dir = __dirname + '/config/login/';
    this.ensureExists(dir, 0744, function (error) {
        if (error) {
            return callback(error);
        }

        fs.readFile(dir + 'login.json', 'utf8', function (err, data) {
            if (err) {
                return callback(err);
            }

            callback(null, JSON.parse(data));
        })
    });
}
