/* jshint node: true, esversion: 9, unused: false */
'use strict';

var fs = require('fs-extra');
var libQ = require('kew');
var ping = require('ping');
var fetch = require('node-fetch');

var dnsSync = require('dns-sync');
const { serviceName, sourceName, uriParts, uriPrefix, uriStaRE } = require('./common');
const { PUtil } = require('./helpers');
const { ExpireOldTracks, PreventAuthTimeout, StreamLifeChecker, StationDataPublisher } = require('./timers');
const { PandoraHandler } = require('./pandora_handler');
var mqtt_handler = require('./mqtt_handler');

module.exports = ControllerPandora;
function ControllerPandora(context) {
    var self = this;

    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;

    this.pUtil = new PUtil(this);

    self.loggedIn = false;
    self.stationData = {};
    self.currStation = {};
    self.lastUri = null;
    // self.lastPress = Date.now();
    self.lastStationUpdate = Date.now();
    self.cameFromMenu = false;
    self.responseSorted = {};
    self.state = {};
}


ControllerPandora.prototype.onVolumioStart = function () {
    // var self = this;
    var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);

    return libQ.resolve();
};

ControllerPandora.prototype.onStart = function () {
    var self = this;

    self.mqttEnabled = self.config.get('mqttEnabled', false);
    self.useCurl302WorkAround = self.config.get('useCurl302WorkAround', false);
    self.nextIsThumbsDown = self.config.get('nextIsThumbsDown', false);
    self.flushThem = self.config.get('flushThem', false);
    self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');

    self.addToBrowseSources();

    return self.initialSetup()
};

ControllerPandora.prototype.onStop = function () {
    // Once the Plugin has successfull stopped resolve the promise
    var self = this;

    if (typeof(self.expireHandler) !== 'undefined') self.expireHandler.stop();
    if (typeof(self.streamLifeChecker) !== 'undefined') self.streamLifeChecker.stop();
    if (typeof(self.preventAuthTimeout)  !== 'undefined') self.preventAuthTimeout.stop();
    if (typeof(self.stationDataHandler) !== 'undefined') self.stationDataHandler.stop();
    if (typeof(self.mqttHandler) !== 'undefined') self.mqttHandler.disconnect();

    return self.flushPandora()
        .then(() => self.stop())
        .then(() => {
            self.commandRouter.volumioRemoveToBrowseSources(sourceName);
            return libQ.resolve();
        });
};

ControllerPandora.prototype.onRestart = function () {
    var self = this;
    // Optional, use if you need it
};

// Online Check Methods ----------------------------------------------------------------------

// Online Ping Check
ControllerPandora.prototype.checkPing = function (host='www.google.com') {
    var self = this;
    var defer = libQ.defer();
    const fnName = 'checkPing';
    const pingInterval = 5000; // milliseconds

    self.pUtil.announceFn(fnName);

    let pingTestID = setInterval(function pingTest (result) {
        if (result.count * pingInterval === 600 * 1000) { // approximately 10 minutes
            const errMsg = 'Pandora plugin will not be started.  Could not reach ' + host;
            self.pUtil.logError(fnName, errMsg);
            self.commandRouter.pushToastMessage('error', 'Pandora', errMsg);

            defer.reject();
            clearInterval(pingTestID);
        }

        if (!result.done) {
            ping.sys.probe(host, function(hostReached) {
                if (hostReached) {
                    result.done = true;

                    clearInterval(pingTestID);
                    defer.resolve();

                    self.pUtil.logInfo(fnName, '***LOOKS GOOD, ICE DOWN THE BEERS IN THE COOLER***');
                }
            });

            if ((result.count * 10 * 1000 / pingInterval) % 10 === 0) { // every 10 seconds
                const pingStatMsg = 'Ping ' + host + ', attempt ' + result.count + ' failed';
                self.pUtil.logInfo(fnName, pingStatMsg);
            }

            let toastMsg = '';
            if (result.count * pingInterval === 30 * 1000) { // approximately 30 seconds
                toastMsg = 'Cannot ping ' + host +
                    '.  Delaying Pandora start until Internet connects.'
            }
            else if (result.count * pingInterval === 90 * 1000) { // approximately 1 minute 30 seconds
                toastMsg = 'Still cannot ping ' + host + '.  Waiting....'
            }
            if (toastMsg.length > 0) {
                self.pUtil.logInfo(fnName, toastMsg);
                self.commandRouter.pushToastMessage('warning', 'Pandora', toastMsg);
            }

            result.count++;
        }
    }, pingInterval, {done: false, count: 1});

    return defer.promise;
}

// Online Request Check -- See https://paulgalow.com/how-to-check-for-internet-connectivity-node/
ControllerPandora.prototype.checkHTTP = function (urlToCheck='https://8.8.8.8') {
    var self = this;
    var defer = libQ.defer();
    const fnName = 'checkHTTP';
    const fetchInterval = 5000; // milliseconds

    self.pUtil.announceFn(fnName);

    let urlTestID = setInterval(function urlTest(result) {
        if (result.count * fetchInterval === 600 * 1000) { // approximately 10 minutes
            const errMsg = 'Pandora plugin will not be started.  Could not reach ' + urlToCheck;
            self.pUtil.logError(fnName, errMsg);
            self.commandRouter.pushToastMessage('error', 'Pandora', errMsg);

            clearInterval(urlTestID);
            defer.reject(errMsg);
        }
        
        if (!result.done) {
            fetch(urlToCheck)
                .then(response => response.status)
                .then(status => {
                    if (status >= 200 && status <= 300) {
                        clearInterval(urlTestID);
                        defer.resolve();

                        self.pUtil.logInfo(fnName, '***CRACK THE BEERS WE HAVE INTERNET***')
                        result.done = true;
                    }
                })
                .catch(err => {
                    // const msg = 'Fetch ' + urlToCheck + ' attempt ' + result.count++ + ' gave an error';
                    // self.pUtil.logInfo(fnName, msg);
                });

                if ((result.count * 10 * 1000 / fetchInterval) % 10 === 0) { // every 10 seconds
                    const msg = 'Fetch ' + urlToCheck + ', attempt ' + result.count + ' failed';
                    self.pUtil.logInfo(fnName, msg);
                }

                let toastMsg = '';
                if (result.count * fetchInterval === 15 * 1000) { // approximately 15 seconds
                    toastMsg = 'Ping works but web requests are not working.  Still waiting....'
                }
                else if (result.count * fetchInterval === 90 * 1000) { // approximately 1 minute 30 seconds
                    toastMsg = 'Web requests still not working.  Waiting....'
                }
                if (toastMsg.length > 0) {
                    self.pUtil.logInfo(fnName, toastMsg);
                    self.commandRouter.pushToastMessage('warning', 'Pandora', toastMsg);
                }   

                result.count++;                
        }
    }, fetchInterval, {done: false, count:1});

    return defer.promise;
}

// Setup Methods -----------------------------------------------------------------------------

ControllerPandora.prototype.flushPandora = function () {
    var self = this;
    const fnName = 'flushPandora';

    self.pUtil.announceFn(fnName);

    const newQ = self.getQueue().filter(item => item.service !== serviceName);

    if (newQ.length > 0) {
        self.commandRouter.stateMachine.playQueue.clearAddPlayQueue(newQ);
    }
    else {
        self.commandRouter.stateMachine.playQueue.clearPlayQueue();
        // self.pUtil.logInfo(fnName, 'running clearQueue()');
        // self.commandRouter.stateMachine.clearQueue();
    }
    return libQ.resolve();
};

ControllerPandora.prototype.loadI18nStrings = function () {
    var self = this;
    self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

ControllerPandora.prototype.getI18nString = function (key) {
    var self = this;

    if (self.i18nStrings['BROWSE'][key] !== undefined)
        return self.i18nStrings['BROWSE'][key];
    else
        return self.i18nStringsDefaults['BROWSE'][key];
};

ControllerPandora.prototype.initialSetup = function () {
    var self = this;

    const pandoraHandlerOptions = {
        email: self.config.get('email', ''),
        password: self.config.get('password', ''),
        isPandoraOne: self.config.get('isPandoraOne', false),
    };

    const mqttOptions = {
        mqttEnabled: self.mqttEnabled,
        mqttHost: self.config.get('mqttHost', ''),
        mqttPort: self.config.get('mqttPort', ''),
        mqttUsername: self.config.get('mqttUsername', ''),
        mqttPassword: self.config.get('mqttPassword', '')
    };

    self.pUtil.announceFn('initialSetup');

    self.pandoraHandler = new PandoraHandler(self);
    self.stationDataHandler = new StationDataPublisher(self);

    self.loadI18nStrings();

    return self.checkPing()
        .then(() => self.checkHTTP())
        .then(() => self.initializeMQTT(mqttOptions))
        .then(() => self.pandoraHandler.init())
        .then(() => self.validateAndSetAccountOptions(pandoraHandlerOptions))
        .then(() => self.pandoraHandler.setMQTTEnabled(self.mqttEnabled))
        .then(() => {
            const maxStationTracks = self.config.get('maxStationTracks', '16');
            const bandFilter = self.config.get('bandFilter', '');
            return self.pandoraHandler.setMaxStationTracks(maxStationTracks)
                .then(() => self.pandoraHandler.setBandFilter(bandFilter));
        })
        .then(() => self.flushPandora());
};

// Configuration Methods -----------------------------------------------------------------------------

ControllerPandora.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(uiconf => {
            const opts = [
                [
                    'email',
                    'password',
                    'isPandoraOne'
                ],
                [
                    'useCurl302WorkAround',
                    'nextIsThumbsDown',
                    'superPrevious',
                    'maxStationTracks',
                    'flushThem',
                    'bandFilter'
                ],
                [
                    'mqttEnabled',
                    'mqttHost',
                    'mqttPort',
                    'mqttUsername',
                    'mqttPassword'
                ]
            ];

            for (let s = 0; s < opts.length; s++) {
                for (let c = 0; c < opts[s].length; c++) {
                    const value = self.config.get(opts[s][c], '');
                    uiconf.sections[s].content[c].value = value;
                }
            }

            defer.resolve(uiconf);
        })
        .fail(err => {
            defer.reject(new Error('[Pandora] Failed to load UIConfig.json' + err));
        });

    return defer.promise;
};

ControllerPandora.prototype.getConfigurationFiles = function () {
    return ['config.json'];
};

ControllerPandora.prototype.setUIConfig = function (data) {
    var self = this;
    //Perform your installation tasks here
};

ControllerPandora.prototype.getConf = function (varName) {
    var self = this;
    //Perform your installation tasks here
};

ControllerPandora.prototype.setAccountOptionsConf = function (accountOptions) {
    var self = this;

    const propNames = [
        'email',
        'password',
        'isPandoraOne'
    ];
    propNames.forEach(item => {
        self.config.set(item, accountOptions[item]);
    });

    self.isPandoraOne = accountOptions.isPandoraOne;

    self.commandRouter.pushToastMessage(
        'info', 'Pandora Options', 'Account Options Saved'
    );

    // return self.validateAndSetAccountOptions(accountOptions)
    //     .then(() => self.pUtil.timeOutToast('validateAndSetAccountOptions', 'success',
    //         'Pandora Options', 'Account Options Validated', 5000));
    return self.validateAndSetAccountOptions(accountOptions);
};

ControllerPandora.prototype.setPlaybackOptionsConf = function (playbackOptions) {
    var self = this;

    const propNames = [
        'useCurl302WorkAround',
        'nextIsThumbsDown',
        'superPrevious',
        'flushThem'
    ];
    propNames.forEach(item => {
        self.config.set(item, playbackOptions[item]);
        self[item] = playbackOptions[item];
    });

    self.config.set('bandFilter', playbackOptions.bandFilter);

    return self.validateMaxStationTracks(playbackOptions.maxStationTracks)
        .then(maxStationTracks => {
            self.config.set('maxStationTracks', maxStationTracks);

            if (typeof(self.pandoraHandler) !== 'undefined') {
                return self.pandoraHandler.setMaxStationTracks(maxStationTracks)
                    .then(() => self.pandoraHandler.setBandFilter(
                        playbackOptions.bandFilter));
            }
            return libQ.resolve();
        })
        .then(() => self.pUtil.timeOutToast(
            'setPlaybackOptionsConf', 'info', 'Pandora Options',
            'Playback Options Saved', 0));
};

ControllerPandora.prototype.setMQTTOptionsConf = function (mqttOptions) {
    var self = this;
    const fnName = 'setMQTTOptionsConf';

    self.pUtil.announceFn(fnName);

    const propNames = [
        'mqttEnabled',
        'mqttHost',
        'mqttPort',
        'mqttUsername',
        'mqttPassword'
    ];
    propNames.forEach(item => {
        self.config.set(item, mqttOptions[item]);
    });

    self.mqttEnabled = mqttOptions.mqttEnabled;

    self.commandRouter.pushToastMessage(
        'info', 'Pandora Options', 'MQTT Options Saved'
    );

    return self.initializeMQTT(mqttOptions);
};

ControllerPandora.prototype.validateMaxStationTracks = function (maxTracks) {
    var self = this;
    const maxStationTracksDefault = 16;
    const maxStationTracksMin = 8;

    const head = 'Invalid Song Maximum!\n';
    const middle = 'Should be at least ' + maxStationTracksMin + '\n';
    const tail = 'Setting to default (' + maxStationTracksDefault + ').';

    let mqParsed = parseInt(maxTracks);
    let msg = isNaN(mqParsed) ? head + tail : head + middle + tail;

    let result = maxStationTracksDefault;
    if (mqParsed >= maxStationTracksMin) {
        result = mqParsed;
    }
    else {
        self.commandRouter.pushToastMessage('warning', 'Pandora Options', msg);
    }

    return libQ.resolve(result);
};

ControllerPandora.prototype.initializeMQTT = function (options) {
    var self = this;
    const fnName = 'initializeMQTT';

    self.pUtil.announceFn(fnName);

    if (options.mqttEnabled === true) {
        if (typeof(self.mqttHandler) === 'undefined') {
            self.mqttHandler = new mqtt_handler.MQTTHandler(self);
        }
        if (!options.mqttPort) options.mqttPort = 1883;

        return self.mqttHandler.init(options)
            .then(() => self.mqttHandler.connect());
    }
    self.pUtil.logInfo(fnName, 'MQTT is not enabled in Plugin Configuration');

    return libQ.resolve();
};

// validates Pandora login credentials
ControllerPandora.prototype.validateAndSetAccountOptions = function (rawOptions) {
    var self = this;
    const fnName = 'validateAndSetAccountOptions';

    self.pUtil.announceFn(fnName);

    const email = rawOptions.email;
    const password = rawOptions.password;
    const isPandoraOne = rawOptions.isPandoraOne;

    self.loggedIn = false; // MIGHT NOT NEED THIS

    if ((typeof(email) === 'undefined' || typeof(password) === 'undefined') ||
        (!email || !password)) {
        const msg = 'Need email address and password.  See plugin settings.';

        self.pUtil.timeOutToast(fnName, 'warning', 'Pandora Options', msg, 5000);
        self.pUtil.logError(fnName, msg);

        return libQ.resolve();
    }

    // let's go!
    return self.pandoraHandler.setAccountOptions(email, password, isPandoraOne)
        .then(() => {
            self.stationData = {};
            self.preventAuthTimeout = new PreventAuthTimeout(self);

            return self.flushPandora()
                .then(() => self.preventAuthTimeout.init())
                .then(() => self.pandoraHandler.pandoraLoginAndGetStations())
                .then(() => self.pandoraHandler.getLoginStatus())
                .then(result => {
                    self.loggedIn = result;
                    self.pUtil.logInfo(fnName, '***DEBUG*** self.loggedIn: ' + self.loggedIn);

                    self.expireHandler = new ExpireOldTracks(self);
                    self.streamLifeChecker = new StreamLifeChecker(self);

                    return self.expireHandler.init();
                })
                .then(() => self.pandoraHandler.fillStationData());
        });
};

// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it

// Use this function to add your music service plugin to music sources
ControllerPandora.prototype.addToBrowseSources = function () {
    var data = {
        name: sourceName,
        uri: '/pandora',
        albumart: '/albumart?sourceicon=music_service/pandora/pandora.png',
        icon: 'fa fa-microphone',
        plugin_type: 'music_service',
        plugin_name: serviceName
    };

    return this.commandRouter.volumioAddToBrowseSources(data);
};

ControllerPandora.prototype.handleBrowseUri = function (curUri) {
    var self = this;
    const fnName = 'handleBrowseUri';
    const sortData = [
        {
            type: 'ageNew',
            desc: 'PANDORA_BROWSE_NEW',
            fn: (a, b) => (parseInt(a[0]) < parseInt(b[0])) ? 1 : -1
        },
        {
            type: 'ageOld',
            desc: 'PANDORA_BROWSE_OLD',
            fn: (a, b) => (parseInt(a[0]) > parseInt(b[0])) ? 1 : -1
        },
        {
            type: 'alphaFwd',
            desc: 'PANDORA_BROWSE_ATOZ',
            fn: (a, b) => (a[1].name > b[1].name) ? 1 : -1
        },
        {
            type: 'alphaRev',
            desc: 'PANDORA_BROWSE_ZTOA',
            fn: (a, b) => (a[1].name < b[1].name) ? 1 : -1
        }
    ];
    const sortTypeUris = sortData.map(i => uriParts.keys[0] + '/' + i.type);

    const responseRoot = {
        navigation: {
            'prev': { uri: uriParts.keys[0] },
            'lists': [
                {
                    'availableListViews': ['list'],
                    'items': [
                        {
                            service: serviceName,
                            type: 'station',
                            title: self.getI18nString(sortData[0].desc),
                            artist: '',
                            album: '',
                            icon: 'fa fa-folder-open-o',
                            uri: uriParts.keys[0] + '/' + sortData[0].type
                        },
                        {
                            service: serviceName,
                            type: 'station',
                            title: self.getI18nString(sortData[1].desc),
                            artist: '',
                            album: '',
                            icon: 'fa fa-folder-open-o',
                            uri: uriParts.keys[0] + '/' + sortData[1].type
                        },
                        {
                            service: serviceName,
                            type: 'station',
                            title: self.getI18nString(sortData[2].desc),
                            artist: '',
                            album: '',
                            icon: 'fa fa-folder-open-o',
                            uri: uriParts.keys[0] + '/' + sortData[2].type
                        },
                        {
                            service: serviceName,
                            type: 'station',
                            title: self.getI18nString(sortData[3].desc),
                            artist: '',
                            album: '',
                            icon: 'fa fa-folder-open-o',
                            uri: uriParts.keys[0] + '/' + sortData[3].type
                        }
                    ]
                }
            ]
        }
    };

    var responseNoLogin = {
        navigation: {
            'prev': { uri: uriParts.keys[0] },
            'lists': [
                {
                    'availableListViews': ['list'],
                    'items': [
                        {
                            service: serviceName,
                            type: 'station',
                            title: 'Not logged into Pandora - Check Plugin Settings',
                            artist: '',
                            album: '',
                            icon: 'fa fa-exclamation-triangle',
                            uri: uriParts.keys[0]
                        },
                        {
                            service: serviceName,
                            type: 'station',
                            title: 'See Plugins -> Installed Plugins -> pandora -> Settings',
                            artist: '',
                            album: '',
                            icon: 'fa fa-exclamation-triangle',
                            uri: uriParts.keys[0]
                        }
                    ]
                }
            ]
        }
    };

    var responseSorted = {
        navigation: {
            'prev': { uri: uriParts.keys[0] },
            'lists': [
                {
                    'availableListViews': ['list'],
                    'items': []
                }
            ]
        }
    };

    function checkForStationChange(newStationToken) {
        const stationChanged = (self.currStation.stationToken !== newStationToken);

        if (!Object.keys(self.stationData).includes(newStationToken)) {
            const subFnName = fnName + '::checkForStationChange';
            const errMsg = 'newStationToken not found in self.stationData';
            self.commandRouter.pushToastMessage('error', 'Pandora', errMsg);

            return self.pUtil.generalReject(subFnName, errMsg);
        }
        return self.setCurrStationInfo(newStationToken)
            .then(() => {
                if (stationChanged && self.flushThem) {
                    return self.flushPandora();
                }
            });
    }

    self.pUtil.announceFn(fnName);

    // if (Object.keys(self.stationData).length === 0) {
    if (!self.loggedIn) {
        const errMsg = 'Not logged into Pandora Servers.  Check plugin settings and click to refresh.';
        self.commandRouter.pushToastMessage('warning', 'Pandora', errMsg);

        return libQ.resolve(responseNoLogin);
    }

    return self.checkForExpiredStations() // SHOULD 'RETURN' BE REMOVED?
        .then(() => self.pandoraHandler.getStationData())
        .then(result => {
            self.stationData = result; // this looks good here

            if (curUri === uriParts.keys[0]) { // root response
                return libQ.resolve(responseRoot);
            }
            else if (sortTypeUris.includes(curUri)) { // station sorting choice
                const entries = Object.entries(self.stationData).sort(sortData[sortTypeUris.indexOf(curUri)].fn);
                entries.forEach(pair => { // [key, value]
                    responseSorted.navigation.lists[0].items.push({
                        service: serviceName,
                        type: 'station',
                        artist: pair[1].artist,
                        title: pair[1].name,
                        name: pair[1].name,
                        album: pair[1].album,
                        albumart: pair[1].albumart,
                        icon: 'fa fa-music',
                        uri: uriPrefix + pair[0]
                    });
                });

                self.reponseSorted = responseSorted;
                return libQ.resolve(responseSorted);
            }
            else if (curUri.match(uriStaRE) !== null) { // station chosen
                const stationToken = curUri.match(uriStaRE)[1];

                return checkForStationChange(stationToken)
                    .then(() => self.pandoraHandler.fetchTracks())
                    .then(() => {
                        self.lastUri = null;
                        self.cameFromMenu = true;

                        return self.pandoraHandler.getNewTracks()
                            .then(newTracks => {
                                if (newTracks.length > 0) {
                                    return self.commandRouter.stateMachine.playQueue.addQueueItems(newTracks)
                                        .then(() => self.getQueueIndex(newTracks[0].uri))
                                        .then(index => {
                                            self.setCurrQueuePos(index);
                                            return self.commandRouter.stateMachine.play(index);
                                        })
                                        .then(() => {
                                            if (Object.keys(self.responseSorted) === 0) {
                                                return libQ.resolve(responseRoot);
                                            }
                                            else {
                                                return libQ.resolve(self.responseSorted);
                                            }
                                        });
                                }

                                self.commandRouter.pushToastMessage('error', 'Pandora',
                                    'Failed to load tracks from ' + self.currStation.name);

                                return self.pUtil.generalReject(fnName, 'Failed to load tracks from ' +
                                    self.currStation.name);
                            });

                    });
            }
            else {
                return self.pUtil.generalReject(fnName, 'Failed to match uri: ' + curUri);
            }
        });
};

// add tags to newTracks and add to mpd queue
ControllerPandora.prototype.appendTracksToMpd = function (newTracks) {
    var self = this;
    var defer = libQ.defer();

    const fnName = 'appendTracksToMpd';
    self.pUtil.announceFn(fnName);

    // resolve address to numeric IP by DNS lookup
    function resolveTrackUri (uri) {
        let result = null;
        const subFnName = fnName + '::resolveTrackUri';

        try {
            let start = uri.indexOf('//') + 2;
            let host = uri.substr(start, uri.indexOf('/', start) - start);
            result = uri.replace(host, dnsSync.resolve(host));

            self.pUtil.logInfo(subFnName, uri + ' => ' + result);
        } catch (err) {
            self.pUtil.logError(subFnName, 'Error resolving ' + uri, err);
            self.commandRouter.pushToastMessage('error', 'Pandora',
                subFnName + ' error');
            result = uri;
        }

        return libQ.resolve(result);
    }

    function setTrackTags(input) {
        (() => self.useCurl302WorkAround ?
            resolveTrackUri(input.realUri) :
            libQ.resolve(input.realUri))()
            .then(realUri => self.mpdPlugin.sendMpdCommand('addid', [realUri]))
            .then(result => {
                let tagUpdateCmds = [
                    { command: 'addtagid', parameters: [result.Id, 'artist', input.artist] },
                    { command: 'addtagid', parameters: [result.Id, 'album', input.album] },
                    { command: 'addtagid', parameters: [result.Id, 'title', input.title] }
                ];

                return self.mpdPlugin.sendMpdCommandArray(tagUpdateCmds);
            });
    }

    let promises = [];
    newTracks.forEach(item => promises.push(setTrackTags(item)));
    self.pUtil.logInfo(fnName, 'Added ' + newTracks.length + ' track(s) to mpd');

    libQ.all(promises)
        .fail(err => {
            self.pUtil.logError(fnName, ' Error in setTrackTags()', err);
            defer.reject(self.pandoraPrefix() + fnName + ' error: ' + err);
        })
        .then(defer.resolve());

    return defer.promise;
};

ControllerPandora.prototype.setCurrStationInfo = function (stationToken) {
    var self = this;

    self.currStation = {
        name: self.stationData[stationToken].name,
        stationToken: stationToken
    };

    if (self.mqttEnabled) {
        const stationNameObj = {
            stationName: self.currStation.name
        };
        return self.mqttHandler.publishData(
            stationNameObj,
            'stationName'
        );
    }
    return libQ.resolve();
};

ControllerPandora.prototype.getQueueIndex = function (uri) {
    var self = this;
    return self.getQueue().findIndex(item => item.uri === uri);
};

ControllerPandora.prototype.getQueue = function () {
    var self = this;
    return self.commandRouter.stateMachine.playQueue.getQueue();
};

ControllerPandora.prototype.getCurrQueuePos = function () {
    var self = this;
    return self.commandRouter.stateMachine.currentPosition;
};

ControllerPandora.prototype.setCurrQueuePos = function (newQPos) {
    var self = this;
    self.commandRouter.stateMachine.currentPosition = newQPos;
};

ControllerPandora.prototype.getQueueTrack = function (pos=this.getCurrQueuePos()) {
    var self = this;
    return self.commandRouter.stateMachine.getTrack(pos);
};

ControllerPandora.prototype.getStationTracks = function (stationToken) {
    var self = this;

    self.pUtil.announceFn('getStationTracks');

    return libQ.resolve(self.getQueue().filter(item =>
        item.service === serviceName && // short-circuit test
        item.stationToken == stationToken));
};

ControllerPandora.prototype.removeTrack = function (trackUri, justOldTracks=false) {
    var self = this;
    const fnName = 'removeTrack';
    const qPos = self.getCurrQueuePos();
    const index = self.getQueueIndex(trackUri);

    let test = (index != -1 && index != qPos && trackUri);
    const beforeQPos = (index < qPos);
    if (justOldTracks) {
        test = (test && beforeQPos);
    }

    self.pUtil.announceFn(fnName);

    if (test) {
        self.commandRouter.stateMachine.removeQueueItem({value: index});
        self.pUtil.logInfo(fnName, 'Removed track with uri: ' +
            trackUri + ' at queue index: ' + index);
        return self.mpdPlugin.getState()
            .then(state => self.pushState(state));
    }
    else {
        self.pUtil.logInfo(fnName, 'Not removing track with uri: ' +
            trackUri + ' at queue index: ' + index);
        return libQ.resolve();
    }
};

ControllerPandora.prototype.removeStationTracks = function (stationToken, limit) {
    var self = this;
    const fnName = 'removeStationTracks';
    let promises = [];

    self.pUtil.announceFn(fnName);

    return self.getStationTracks(stationToken)
        .then(stationQ => {
            const num = limit ? limit : stationQ.length;

            for (let i = 0; i < num; i++) {
                promises.push(self.pUtil.siesta(
                    self.removeTrack.bind(self),
                    fnName,
                    [stationQ[i].uri, true],
                    10000 * (i + 1)
                ));
            }
            libQ.all(promises)
                .fail(err => self.pUtil.generalReject(fnName, err))
                .then(() => self.pUtil.logInfo(fnName, 'Removing ' +
                    num + ' tracks from queue'));
    });
};

// Remove oldest Pandora tracks from queue to make room for new ones
ControllerPandora.prototype.removeOldTrackBlock = function (pQPos, diff) {
    var self = this;
    const fnName = 'removeOldTrackBlock';
    const limit = Math.min(pQPos, diff);

    self.pUtil.announceFn(fnName);

    return self.removeStationTracks(self.currStation.stationToken, limit);
};

ControllerPandora.prototype.fetchAndAddTracks = function (curUri) {
    var self = this;
    const fnName = 'fetchAndAddTracks';

    function getSQInfo() {
        self.pUtil.announceFn(fnName + '::getSqInfo');

        return self.getStationTracks(self.currStation.stationToken)
            .then(stationQ => { // stationQ: current station tracks
                const Q = self.getQueue();
                const qLen = Q.length;
                const sQLen = stationQ.length;
                // sQPos: song pos in SQ
                const sQPos = stationQ.findIndex(item => item.uri === curUri);
                // isSQLast: SQ @ end of playQueue
                const isSQLast = (stationQ[sQLen - 1].uri === Q[qLen - 1].uri) &&
                    (stationQ[0].uri === Q[qLen - sQLen].uri);

                return libQ.resolve({ sQPos: sQPos, isSQLast: isSQLast });
            });
    }

    function moveStationTracks(tracks) {
        const subFnName = fnName + '::moveStationTracks';
        const trackLen = tracks.length;
        const qLen = self.getQueue().length;
        let msg = 'Moved tracks [';
        let finalPos;

        self.pUtil.announceFn(subFnName);

        let to = self.oldQLen - 1;
        if (!self.cameFromMenu) {
            self.oldQLen = qLen;
            to = qLen - 1;
        }

        for (let i = 0; i < trackLen; i++) {
            let trackToMove = tracks.shift();
            let from = self.getQueueIndex(trackToMove.uri);
            self.commandRouter.stateMachine.moveQueueItem(from, to);
            msg += (i < tracks.length - 1) ? i + ', ' :
                i + '] from ' + from + ' to ' + to;
        }
        self.pUtil.logInfo(subFnName, msg);

        if (!self.cameFromMenu) { // set new Qpos
            getSQInfo()
                .then(sqInfo => libQ.resolve(sqInfo.sQPos))
                .then(sQPos => {
                    finalPos = to - trackLen + sQPos + 1;
                    self.setCurrQueuePos(finalPos);
                    self.pUtil.logInfo(subFnName,
                        'Set new Queue Position to ' +
                        finalPos);
                    self.mpdPlugin.getState()
                        .then(state => self.pushState(state));
                });
        }
        return libQ.resolve();
    }

    function checkIfMovingTracks(isSQLast) {
        if (!self.flushThem) { // multiple stations in queue
            if (!isSQLast) {
                return self.getStationTracks(self.currStation.stationToken)
                    .then(stationTracks => moveStationTracks(stationTracks));
            }
            self.cameFromMenu = false; // *** WHAT'S GOING ON WITH THIS BOOLEAN?
        }

        return libQ.resolve();
    }

    self.pUtil.announceFn(fnName);

    if (self.state.artist && self.state.title) {
        return self.pandoraHandler.getSongMaxDiff()
            .then(diff1 => {
                return getSQInfo()
                    .then(sQInfo1 => {
                        self.pUtil.logInfo(fnName, 'diff1: ' + diff1 +
                            ' sQPos1: ' + sQInfo1.sQPos);
                        if (sQInfo1.sQPos != 0 || diff1 < 0) { // will fetch tracks
                            self.pUtil.logInfo(fnName, 'Fetching tracks');
                            self.pandoraHandler.fetchTracks()
                                .then(() => self.pandoraHandler.getNewTracks())
                                .then(newTracks => {
                                    if (newTracks) {
                                        // don't add tracks twice (WILL REVISIT)
                                        // let Q = self.getQueue();
                                        // if (!newTracks.map(i => i.uri).some(uri => Q.map(j => j.uri).includes(uri))) {
                                        return checkIfMovingTracks(sQInfo1.isSQLast)
                                            .then(() => self.commandRouter.stateMachine.playQueue.addQueueItems(newTracks))
                                            .then(() => self.pandoraHandler.getSongMaxDiff())
                                            .then(diff2 => {
                                                if (diff2 > 0) {
                                                    return getSQInfo()
                                                        .then(sQInfo2 => {
                                                            self.pUtil.logInfo(fnName, 'diff2 > 0: ' + diff2 +
                                                                ' sQPos2: ' + sQInfo2.sQPos);
                                                            return self.removeOldTrackBlock(sQInfo2.sQPos, diff2);
                                                        });
                                                }
                                            });

                                    }
                                });
                        }
                        else { // no fetch
                            self.pUtil.logInfo(fnName, 'Not fetching tracks: qPos == 0 && diff1 >= 0');
                            return checkIfMovingTracks(sQInfo1.isSQLast);
                        }
                    });
            });
    }
    return libQ.resolve();
};

// This callback runs after mpd player 'player' event
ControllerPandora.prototype.pandoraListener = function () {
    var self = this;
    const fnName = 'pandoraListener';

    self.pUtil.announceFn(fnName);

    self.mpdPlugin.getState()
        .then(state => {
            let nextTrack = self.getQueueTrack();

            if (nextTrack.service && nextTrack.service === serviceName) {
                self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));
                return self.pushState(state);
            }
            else {
                self.pUtil.logInfo(fnName, 'Removing pandoraListener');
            }
        });
};

ControllerPandora.prototype.checkForExpiredStations = function () {
    var self = this;
    const fnName = 'checkForExpiredStations';
    const interval = 5 * 60 * 1000; // 5 minutes
    const stationsExpired = (Date.now() - self.lastStationUpdate >= interval) ? true : false;

    self.pUtil.announceFn(fnName);

    if (stationsExpired) {
        self.lastStationUpdate = Date.now();

        self.pUtil.logInfo(fnName, 'Stations expired');
        return self.pandoraHandler.fillStationData();
    }
    return libQ.resolve();
};

// Define a method to clear, add, and play an array of tracks
ControllerPandora.prototype.clearAddPlayTrack = function (track) {
    var self = this;
    const fnName = 'clearAddPlayTrack';

    self.pUtil.announceFn(fnName);

    // Here we go! (¡Juana's Adicción!)
    return self.mpdPlugin.clear()
        .then(() => self.streamLifeChecker.stop())
        .then(() => self.checkForExpiredStations())
        .then(() => {
            if (self.lastUri !== track.uri && self.currStation.stationToken == track.stationToken) {
                self.removeTrack(self.lastUri);
            }
            self.lastUri = track.uri;

            return self.setCurrStationInfo(track.stationToken) // may be redundant -- investigate!
                .then(() => self.appendTracksToMpd([track]));
        })
        .then(() => {
            self.mpdPlugin.clientMpd.removeAllListeners('system-player');
            self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));

            return self.mpdPlugin.sendMpdCommand('play', []);
        })
        .then(() => self.parseState(track))
        .then(state => {
            self.state = state;
            self.state.seek = 0;
            self.state.status = 'play';

            return self.pushState(self.state);
        })
        .then(() => self.fetchAndAddTracks(track.uri))
        .fail(err => {
            self.pUtil.logError(fnName, 'Error', err);
            return self.goPreviousNext('skip');
        });
};

// ControllerPandora.prototype.seek = function (position) {
//     var self = this;

//     // self.pUtil.announceFn('seek to ' + position);

//     // return self.mpdPlugin.seek(position);
// };

// Stop
ControllerPandora.prototype.stop = function () {
    var self = this;

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.lastUri = null;

    self.pUtil.announceFn('stop');

    return self.mpdPlugin.stop()
        .then(() => self.mpdPlugin.clear())
        .then(() => {
            self.state.status = 'stop';
            return self.pushState(self.state);
        });
};

// Spop pause
ControllerPandora.prototype.pause = function () {
    var self = this;

    self.pUtil.announceFn('pause');

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');

    return self.streamLifeChecker.stop()
        .then(() => self.mpdPlugin.pause())
        .then(() => {
            let vState = self.commandRouter.stateMachine.getState();
            self.state.status = 'pause';
            self.state.seek = vState.seek;
            return self.pushState(self.state);
        });
};

ControllerPandora.prototype.resume = function () {
    var self = this;

    self.pUtil.announceFn('resume');

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.mpdPlugin.clientMpd.once('system-player', self.pandoraListener.bind(self));


    return self.mpdPlugin.resume()
        .then(() => self.streamLifeChecker.init())
        .then(() => {
            self.state.status = 'play';
            return self.state.pushState(self.state);
        });
};

// enforce slight delay with media controls to avoid traffic jam
ControllerPandora.prototype.handleMediaButton = function (mediaFn) {
    var self = this;
    const fnName = 'handleMediaButton';
    const timeNow = Date.now();
    const spazPressMs = 250;
    const prevPressMs = 1500;
    const timeDiffMs = timeNow - self.lastPress;
    let result = mediaFn;

    if (timeDiffMs < spazPressMs) { // jumpy user
        // self.pUtil.logInfo(fnName, 'User called ' + mediaFn + ' too rapidly' +
        //     '');
        // self.commandRouter.pushToastMessage('info', 'Pandora',
        //     'Where\'s the fire? Slow down!');
        self.pUtil.logInfo(fnName, 'Media track skipped in less than ' +
            spazPressMs + 'ms.');
        result = 'spaz';
    }
    else if (timeDiffMs > prevPressMs &&
             mediaFn === 'previous' &&
             self.superPrevious) { // replay track
        result = 'replay';
    }

    self.pUtil.logInfo(fnName, 'User chose "' + result + '" function');
    self.lastPress = timeNow;

    return libQ.resolve(result);
};

ControllerPandora.prototype.goPreviousNext = function (fnName) {
    var self = this;
    const qLen = self.getQueue().length;
    const isNotRandom = (self.commandRouter.stateMachine.currentRandom !== true);
    let qPos = self.getCurrQueuePos();

    self.mpdPlugin.clientMpd.removeAllListeners('system-player');
    self.lastUri = null;

    return self.handleMediaButton(fnName)
        .then(result => {
            if (result !== 'spaz') {
                if (fnName === 'previous') {
                    if (result === 'replay') {
                        self.commandRouter.stateMachine.currentSeek = 0; // reset Volumio timer
                    }
                    else if (isNotRandom) { // normal previous
                        qPos = (qPos + qLen - 1) % qLen;
                    }
                    else { // random previous
                        // return self.stop();
                        return self.clearAddPlayTrack();
                    }
                    self.setCurrQueuePos(qPos);
                    return self.clearAddPlayTrack(self.getQueue()[qPos]); // self.clearAddPlayTrack(self.getQueueTrack(qPos))
                }
                else if (fnName === 'next') {
                    // return self.stop()
                    return self.clearAddPlayTrack()
                        .then(() => {
                            if (self.nextIsThumbsDown) { // remove unwanted track
                                // Check if last track in queue -- MAY NOT NEED THIS
                                if (qPos == qLen - 1) {
                                    return self.fetchAndAddTracks(self.getQueueTrack().uri)
                                        .then(() => self.commandRouter.stateMachine.removeQueueItem({value: qPos}));
                                }
                                else {
                                    return self.commandRouter.stateMachine.removeQueueItem({value: qPos});
                                }
                            }
                        });
                }
                else { // 'skip' (bad uri lookup / stream ended)
                    // return self.stop(); // play next consecutive/random track
                    return self.clearAddPlayTrack();
                }
            }
            return libQ.resolve();
        });
};

ControllerPandora.prototype.previous = function () {
    var self = this;
    const fnName = 'previous';

    self.pUtil.announceFn(fnName);

    return self.goPreviousNext(fnName);
};

ControllerPandora.prototype.next = function () {
    var self = this;
    const fnName = 'next';

    self.pUtil.announceFn(fnName);

    if (self.nextIsThumbsDown) {
        return self.pandoraHandler.thumbTrack(self.getQueueTrack(), false)
            .then(() => self.goPreviousNext(fnName));
    }

    return self.goPreviousNext(fnName);
};

ControllerPandora.prototype.thumbTrack = function (isUp) {
    var self = this;
    const fnName = 'thumbTrack';

    self.pUtil.announceFn(fnName);

    return self.pandoraHandler.thumbTrack(self.getQueueTrack(), isUp);
};

ControllerPandora.prototype.clearAndPlayStation = function (stationJSON) {
    var self = this;
    const fnName = 'clearAndPlayStation';
    const stationName = JSON.parse(stationJSON).stationName;

    self.pUtil.announceFn(fnName);

    return self.pandoraHandler.getStationData()
        .then(result => {
            self.stationData = result;

            // stationName has ' Radio' stripped from end
            self.pUtil.logInfo(fnName, 'stationData: ' + JSON.stringify(self.stationData));

            const stationToken = Object.keys(self.stationData)
                .find(key => self.stationData[key].name.startsWith(stationName));

            if (typeof(stationToken) === 'undefined') {
                self.pUtil.logError(fnName, 'Station ' + stationName + ' not found!');
                return libQ.resolve();
            }
            const uri = uriPrefix + stationToken;

            return self.flushPandora()
                .then(() => self.handleBrowseUri(uri));
        });
};

ControllerPandora.prototype.parseState = function (state) {
    // var self = this;

    const strip = ({ // remove extra keys **DO WE NEED THEM? 11/11/2020
        fetchTime,
        station,
        stationToken,
        trackToken,
        uri,
        ...rest
    }) => rest;
    let pState = strip(state);
    pState.uri = state.realUri;

    return libQ.resolve(pState);
};

ControllerPandora.prototype.pushState = function (state) {
    var self = this;

    self.pUtil.announceFn('pushState');

    state.trackType = 'mp3';
    state.bitdepth = '16 bit';
    state.samplerate = '44.1 KHz';
    self.commandRouter.servicePushState(state, serviceName);

    self.commandRouter.stateMachine.setConsumeUpdateService('mpd', true, false);

    return libQ.resolve();
};

ControllerPandora.prototype.explodeUri = function (uri) {
    // Mandatory: retrieve all info for a given URI
    var self = this;
    const fnName = 'explodeUri';

    self.pUtil.announceFn(fnName);

    if (uriStaRE !== null) {
        const newStationToken = uriStaRE[1];

        if (self.currStation.stationToken != newStationToken) { // for checkIfMovingTracks()
            self.oldQ = self.getQueue();
            self.oldQLen = self.oldQ.length;
        }

        // return a one elememnt track object array
        return self.pandoraHandler.getNewTracks()
            .then(tracks => {
                const Q = self.getQueue();
                Q.concat(tracks);
                const response = tracks.filter(item => item.uri == uri).slice(0, 1);

                return libQ.resolve(response);
            });
    }

    let errMsg = 'Could not resolve uri: ' + uri;
    self.commandRouter.pushToastMessage('error', 'Pandora', errMsg);

    return self.pUtil.generalReject(fnName, errMsg);
};

ControllerPandora.prototype.search = function (query) {
    // Mandatory, search. You can divide the search in sections using following functions
    var self = this;

    return libQ.resolve();
};

ControllerPandora.prototype._searchArtists = function (results) {

};

ControllerPandora.prototype._searchAlbums = function (results) {

};

ControllerPandora.prototype._searchPlaylists = function (results) {


};

ControllerPandora.prototype._searchTracks = function (results) {

};

// NOTES:

// We will make an object with the stationToken as the primary key.  *** DONE ***
// When the pandoraHandler fetches new tracks, it will grab a new stationList and check it.
// Alternatively, it could just try to grab a track and handle an error from the API -- *** DO THIS ***

// That code is: *** [1006] STATION_DOES_NOT_EXIST. Station does not exist. ***

// What about clearAddPlayTrack?  it should play the track from a deleted station
// but we need to find out at some point!  we will know when new tracks are fetched

// So if no station, toast a message to that effect, and log the error.
// I'm pretty sure if the station is deleted and an old track is played, it will still play.  *** TEST THIS ***
// That's all I have at 5:35 AM 11/10/2020

// TO DO ALSO:  add sorting option by date created or alphabetical