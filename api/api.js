const http = require('http');
const cluster = require('cluster');
const formidable = require('formidable');
const os = require('os');
const countlyConfig = require('./config', 'dont-enclose');
const plugins = require('../plugins/pluginManager.js');
const jobs = require('./parts/jobs');
const log = require('./utils/log.js')('core:api');
const common = require('./utils/common.js');
const {processRequest} = require('./utils/requestProcessor');

let workers = [];

/**
 * Set Max Sockets
 */
http.globalAgent.maxSockets = countlyConfig.api.max_sockets || 1024;

/**
 * Set Plugins APIs Config
 */
plugins.setConfigs("api", {
    domain: "",
    safe: false,
    session_duration_limit: 120,
    city_data: true,
    event_limit: 500,
    event_segmentation_limit: 100,
    event_segmentation_value_limit: 1000,
    metric_limit: 1000,
    sync_plugins: false,
    session_cooldown: 15,
    request_threshold: 30,
    total_users: true,
    export_limit: 10000,
    prevent_duplicate_requests: true
});

/**
 * Set Plugins APPs Config
 */
plugins.setConfigs("apps", {
    country: "TR",
    timezone: "Europe/Istanbul",
    category: "6"
});

/**
 * Set Plugins Security Config
 */
plugins.setConfigs("security", {
    login_tries: 3,
    login_wait: 5 * 60,
    password_min: 8,
    password_char: true,
    password_number: true,
    password_symbol: true,
    password_expiration: 0,
    dashboard_additional_headers: "X-Frame-Options:deny\nX-XSS-Protection:1; mode=block\nStrict-Transport-Security:max-age=31536000 ; includeSubDomains",
    api_additional_headers: "X-Frame-Options:deny\nX-XSS-Protection:1; mode=block"
});

/**
 * Set Plugins Logs Config
 */
plugins.setConfigs('logs', {
    debug: (countlyConfig.logging && countlyConfig.logging.debug) ? countlyConfig.logging.debug.join(', ') : '',
    info: (countlyConfig.logging && countlyConfig.logging.info) ? countlyConfig.logging.info.join(', ') : '',
    warn: (countlyConfig.logging && countlyConfig.logging.warn) ? countlyConfig.logging.warn.join(', ') : '',
    error: (countlyConfig.logging && countlyConfig.logging.error) ? countlyConfig.logging.error.join(', ') : '',
    default: (countlyConfig.logging && countlyConfig.logging.default) ? countlyConfig.logging.default : 'warn',
}, undefined, () => {
    const cfg = plugins.getConfig('logs'), msg = {cmd: 'log', config: cfg};
    if (process.send) {
        process.send(msg);
    }
    require('./utils/log.js').ipcHandler(msg);
});

/**
 * Initialize Plugins
 */
plugins.init();

/**
 * Uncaught Exception Handler
 */
process.on('uncaughtException', (err) => {
    console.log('Caught exception: %j', err, err.stack);
    if (log && log.e)
        log.e('Logging caught exception');
    process.exit(1);
});

/**
 * Unhandled Rejection Handler
 */
process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled rejection for %j with reason %j stack ', p, reason, reason ? reason.stack : undefined);
    if (log && log.e)
        log.e('Logging unhandled rejection');
});

/**
 * Pass To Master
 * @param worker
 */
const passToMaster = (worker) => {
    worker.on('message', (msg) => {
        if (msg.cmd === 'log') {
            workers.forEach((w) => {
                if (w !== worker) {
                    w.send({cmd: 'log', config: msg.config});
                }
            });
            require('./utils/log.js').ipcHandler(msg);
        }
        else if (msg.cmd === "checkPlugins") {
            plugins.checkPluginsMaster();
        }
        else if (msg.cmd === "startPlugins") {
            plugins.startSyncing();
        }
        else if (msg.cmd === "endPlugins") {
            plugins.stopSyncing();
        }
        else if (msg.cmd === "dispatch" && msg.event) {
            workers.forEach((w) => {
                w.send(msg);
            });
        }
    });
};

if (cluster.isMaster) {
    common.db = plugins.dbConnection();

    const workerCount = (countlyConfig.api.workers)
        ? countlyConfig.api.workers
        : os.cpus().length;

    for (let i = 0; i < workerCount; i++) {
        const worker = cluster.fork();
        workers.push(worker);
    }

    workers.forEach(passToMaster);

    cluster.on('exit', (worker) => {
        workers = workers.filter((w) => {
            return w !== worker;
        });
        const newWorker = cluster.fork();
        workers.push(newWorker);
        passToMaster(newWorker)
    });

    plugins.dispatch("/master", {});

    // Allow configs to load & scanner to find all jobs classes
    setTimeout(() => {
        jobs.job('api:ping').replace().schedule('every 1 day');
        jobs.job('api:clear').replace().schedule('every 1 day');
        jobs.job('api:clearTokens').replace().schedule('every 1 day');
    }, 10000);
} else {
    const taskManager = require('./utils/taskmanager.js');
    common.db = plugins.dbConnection(countlyConfig);
    //since process restarted mark running tasks as errored
    taskManager.errorResults({db: common.db});
    const url = require('url');

    process.on('message', common.log.ipcHandler);

    process.on('message', (msg) => {
        if (msg.cmd === 'log') {
            common.log.ipcHandler(msg);
        }
        else if (msg.cmd === "dispatch" && msg.event) {
            plugins.dispatch(msg.event, msg.data || {});
        }
    });

    plugins.dispatch("/worker", {common: common});

    
    http.Server(function (req, res) {
        plugins.loadConfigs(common.db, function(){
            var urlParts = url.parse(req.url, true),
                queryString = urlParts.query,
                paths = urlParts.pathname.split("/"),
                apiPath = "",
                /**
                * Main request processing object containing all informashed shared through all the parts of the same request
                * @typedef params
                * @type {object}
                * @property {string} href - full URL href
                * @property {res} res - nodejs response object
                * @property {req} req - nodejs request object
                * @property {object} qstring - all the passed fields either through query string in GET requests or body and query string for POST requests
                * @property {string} apiPath - two top level url path, for example /i/analytics
                * @property {string} fullPath - full url path, for example /i/analytics/dashboards
                * @property {object} files - object with uploaded files, available in POST requests which upload files
                * @property {string} cancelRequest - Used for skipping SDK requests, if contains true, then request should be ignored and not processed. Can be set at any time by any plugin, but API only checks for it in beggining after / and /sdk events, so that is when plugins should set it if needed. Should contain reason for request cancelation
                * @property {boolean} bulk - True if this SDK request is processed from the bulk method
                * @property {array} promises - Array of the promises by different events. When all promises are fulfilled, request counts as processed
                * @property {string} ip_address - IP address of the device submitted request, exists in all SDK requests
                * @property {object} user - Data with some user info, like country geolocation, etc from the request, exists in all SDK requests
                * @property {object} app_user - Document from the app_users collection for current user, exists in all SDK requests after validation
                * @property {object} app_user_id - ID of app_users document for the user, exists in all SDK requests after validation
                * @property {object} app - Document for the app sending request, exists in all SDK requests after validation and after validateUserForDataReadAPI validation
                * @property {ObjectID} app_id - ObjectID of the app document, available after validation
                * @property {string} app_cc - Selected app country, available after validation
                * @property {string} appTimezone - Selected app timezone, available after validation
                * @property {object} member - All data about dashboard user sending the request, exists on all requests containing api_key, after validation through validation methods
                * @property {timeObject} time - Time object for the request
                */
                params = {
                    'href':urlParts.href,
                    'qstring':queryString,
                    'res':res,
                    'req':req
                };
                
                //remove countly path
                if(common.config.path == "/"+paths[1]){
                    paths.splice(1, 1);
                }
                
            function processRequest(){
                if (params.qstring.app_id && params.qstring.app_id.length != 24) {
                    common.returnMessage(params, 400, 'Invalid parameter "app_id"');
                    return false;
                }
        
                if (params.qstring.user_id && params.qstring.user_id.length != 24) {
                    common.returnMessage(params, 400, 'Invalid parameter "user_id"');
                    return false;
                }
        
                for (var i = 1; i < paths.length; i++) {
                    if (i > 2) {
                        break;
                    }
        
                    apiPath += "/" + paths[i];
                }
                params.apiPath = apiPath;
                params.fullPath = paths.join("/");
                plugins.dispatch("/", {params:params, apiPath:apiPath, validateAppForWriteAPI:validateAppForWriteAPI, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin, paths:paths, urlParts:urlParts});
        
                if(!params.cancelRequest){
                    switch (apiPath) {
                        case '/i/bulk':
                        {               
                            var requests = params.qstring.requests,
                                appKey = params.qstring.app_key;
                
                            if (requests && typeof requests === "string") {
                                try {
                                    requests = JSON.parse(requests);
                                } catch (SyntaxError) {
                                    console.log('Parse bulk JSON failed', requests, req.url, req.body);
                                    requests = null;
                                }
                            }
                            if(!requests){
                                common.returnMessage(params, 400, 'Missing parameter "requests"');
                                return false;
                            }
                            if (!plugins.getConfig("api").safe && !params.res.finished) {
                                common.returnMessage(params, 200, 'Success');
                            }
                            common.blockResponses(params);
                            function processBulkRequest(i) {
                                if(i == requests.length) {
                                    common.unblockResponses(params);
                                    if (plugins.getConfig("api").safe && !params.res.finished) {
                                        common.returnMessage(params, 200, 'Success');
                                    }
                                    return;
                                }
                                
                                if (!requests[i].app_key && !appKey) {
                                    return processBulkRequest(i + 1);
                                }
                                params.req.body = JSON.stringify(requests[i]);
                                var tmpParams = {
                                    'app_id':'',
                                    'app_cc':'',
                                    'ip_address':requests[i].ip_address || common.getIpAddress(req),
                                    'user':{
                                        'country':requests[i].country_code || 'Unknown',
                                        'city':requests[i].city || 'Unknown'
                                    },
                                    'qstring':requests[i],
                                    'href':"/i",		
                                    'res':params.res,		
                                    'req':params.req,
                                    'promises':[],
                                    'bulk':true
                                };
                                
                                tmpParams["qstring"]['app_key'] = requests[i].app_key || appKey;
                
                                if (!tmpParams.qstring.device_id) {
                                    return processBulkRequest(i + 1);
                                } else {
                                    //make sure device_id is string
                                    tmpParams.qstring.device_id += "";
                                    tmpParams.app_user_id = common.crypto.createHash('sha1').update(tmpParams.qstring.app_key + tmpParams.qstring.device_id + "").digest('hex');
                                }
                
                                return validateAppForWriteAPI(tmpParams, function(){
                                    function resolver(){
                                        plugins.dispatch("/sdk/end", {params:tmpParams}, function(){
                                            processBulkRequest(i + 1);
                                        });
                                    }
                                    Promise.all(tmpParams.promises).then(resolver).catch(function(error) {
                                        console.log(error);
                                        resolver();
                                    });
                                });
                            }
                            
                            processBulkRequest(0);
                            break;
                        }
                        case '/i/users':
                        {
                            if (params.qstring.args) {
                                try {
                                    params.qstring.args = JSON.parse(params.qstring.args);
                                } catch (SyntaxError) {
                                    console.log('Parse ' + apiPath + ' JSON failed', req.url, req.body);
                                }
                            }
            
                            switch (paths[3]) {
                                case 'create':
                                    validateUserForWriteAPI(countlyApi.mgmt.users.createUser, params);
                                    break;
                                case 'update':
                                    validateUserForWriteAPI(countlyApi.mgmt.users.updateUser, params);
                                    break;
                                case 'delete':
                                    validateUserForWriteAPI(countlyApi.mgmt.users.deleteUser, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path, must be one of /create, /update or /delete');
                                    break;
                            }
            
                            break;
                        }
                        case '/i/apps':
                        {
                            if (params.qstring.args) {
                                try {
                                    params.qstring.args = JSON.parse(params.qstring.args);
                                } catch (SyntaxError) {
                                    console.log('Parse ' + apiPath + ' JSON failed', req.url, req.body);
                                }
                            }
            
                            switch (paths[3]) {
                                case 'create':
                                    validateUserForWriteAPI(function(params){
                                        if (!(params.member.global_admin)) {
                                            common.returnMessage(params, 401, 'User is not a global administrator');
                                            return false;
                                        }
                                        countlyApi.mgmt.apps.createApp(params);
                                    }, params);
                                    break;
                                case 'update':
                                    validateUserForWriteAPI(countlyApi.mgmt.apps.updateApp, params);
                                    break;
                                case 'delete':
                                    validateUserForWriteAPI(countlyApi.mgmt.apps.deleteApp, params);
                                    break;
                                case 'reset':
                                    validateUserForWriteAPI(countlyApi.mgmt.apps.resetApp, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path, must be one of /create, /update, /delete or /reset');
                                    break;
                            }
            
                            break;
                        }
                        case '/i/tasks':
                        {
                            if (!params.qstring.task_id) {
                                common.returnMessage(params, 400, 'Missing parameter "task_id"');
                                return false;
                            }
            
                            switch (paths[3]) {
                                case 'update':
                                    validateUserForWriteAPI(function(){
                                        taskmanager.rerunTask({db:common.db, id:params.qstring.task_id}, function(err, res){
                                            common.returnMessage(params, 200, res);
                                        });
                                    }, params);
                                    break;
                                case 'delete':
                                    validateUserForWriteAPI(function(){
                                        taskmanager.deleteResult({db:common.db, id:params.qstring.task_id}, function(err, res){
                                            common.returnMessage(params, 200, "Success");
                                        });
                                    }, params);
                                    break;
                                case 'name':
                                    validateUserForWriteAPI(function(){
                                        taskmanager.deleteResult({db:common.db, id:params.qstring.task_id, name:params.qstring.name}, function(err, res){
                                            common.returnMessage(params, 200, "Success");
                                        });
                                    }, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path');
                                    break;
                            }
            
                            break;
                        }
                        case '/i':
                        {
                            params.ip_address =  params.qstring.ip_address || common.getIpAddress(req);
                            params.user = {};
            
                            if (!params.qstring.app_key || !params.qstring.device_id) {
                                common.returnMessage(params, 400, 'Missing parameter "app_key" or "device_id"');
                                return false;
                            } else {
                                //make sure device_id is string
                                params.qstring.device_id += "";
                                // Set app_user_id that is unique for each user of an application.
                                params.app_user_id = common.crypto.createHash('sha1').update(params.qstring.app_key + params.qstring.device_id + "").digest('hex');
                            }
            
                            if (params.qstring.events) {
                                try {
                                    params.qstring.events = JSON.parse(params.qstring.events);
                                } catch (SyntaxError) {
                                    console.log('Parse events JSON failed', params.qstring.events, req.url, req.body);
                                }
                            }
                            
                            log.d('processing request %j', params.qstring);
                            
                            params.promises = [];
                            validateAppForWriteAPI(params, function(){
                                function resolver(){
                                    plugins.dispatch("/sdk/end", {params:params});
                                }
                                Promise.all(params.promises).then(resolver).catch(function(error) {
                                    console.log(error);
                                    resolver();
                                });
                            });
            
                            if (!plugins.getConfig("api").safe && !params.res.finished) {
                                common.returnMessage(params, 200, 'Success');
                            }
            
                            break;
                        }
                        case '/o/users':
                        {
                            switch (paths[3]) {
                                case 'all':
                                    validateUserForMgmtReadAPI(countlyApi.mgmt.users.getAllUsers, params);
                                    break;
                                case 'me':
                                    validateUserForMgmtReadAPI(countlyApi.mgmt.users.getCurrentUser, params);
                                    break;
                                case 'id':
                                    validateUserForMgmtReadAPI(countlyApi.mgmt.users.getUserById, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path, must be one of /all or /me');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/apps':
                        {
                            switch (paths[3]) {
                                case 'all':
                                    validateUserForMgmtReadAPI(countlyApi.mgmt.apps.getAllApps, params);
                                    break;
                                case 'mine':
                                    validateUserForMgmtReadAPI(countlyApi.mgmt.apps.getCurrentUserApps, params);
                                    break;
                                case 'details':
                                    validateUserForDataReadAPI(params, countlyApi.mgmt.apps.getAppsDetails);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path, must be one of /all , /mine or /details');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/tasks':
                        {
                            switch (paths[3]) {
                                case 'all':
                                    validateUserForMgmtReadAPI(function(){
                                        if(typeof params.qstring.query === "string"){
                                            try{
                                                params.qstring.query = JSON.parse(params.qstring.query);
                                            }
                                            catch(ex){params.qstring.query = {};}
                                        }
                                        params.qstring.query.app_id = params.qstring.app_id;
                                        taskmanager.getResults({db:common.db, query:params.qstring.query}, function(err, res){
                                            common.returnOutput(params, res || []);
                                        });
                                    }, params);
                                    break;
                                case 'task':
                                    validateUserForMgmtReadAPI(function(){
                                        if (!params.qstring.task_id) {
                                            common.returnMessage(params, 400, 'Missing parameter "task_id"');
                                            return false;
                                        }
                                        taskmanager.getResult({db:common.db, id:params.qstring.task_id}, function(err, res){
                                            if(res){
                                                common.returnOutput(params, res);
                                            }
                                            else{
                                                common.returnMessage(params, 400, 'Task does not exist');
                                            }
                                        });
                                    }, params);
                                    break;
                                case 'check':
                                    validateUserForMgmtReadAPI(function(){
                                        if (!params.qstring.task_id) {
                                            common.returnMessage(params, 400, 'Missing parameter "task_id"');
                                            return false;
                                        }
                                        taskmanager.checkResult({db:common.db, id:params.qstring.task_id}, function(err, res){
                                            if(res){
                                                common.returnMessage(params, 200, res.status);
                                            }
                                            else{
                                                common.returnMessage(params, 400, 'Task does not exist');
                                            }
                                        });
                                    }, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/system':
                        {
                            if (!params.qstring.api_key) {
                                common.returnMessage(params, 400, 'Missing parameter "api_key"');
                                return false;
                            }
            
                            switch (paths[3]) {
                                case 'version':
                                    validateUserForMgmtReadAPI(function(){
                                        common.returnOutput(params, {"version":versionInfo.version});
                                    }, params);
                                    break;
                                case 'plugins':
                                    validateUserForMgmtReadAPI(function(){
                                        common.returnOutput(params, plugins.getPlugins());
                                    }, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/export':
                        {
                            if (!params.qstring.api_key) {
                                common.returnMessage(params, 400, 'Missing parameter "api_key"');
                                return false;
                            }
                            
                            function reviver(key, value) {
                                if (value.toString().indexOf("__REGEXP ") == 0) {
                                    var m = value.split("__REGEXP ")[1].match(/\/(.*)\/(.*)?/);
                                    return new RegExp(m[1], m[2] || "");
                                } else
                                    return value;
                            }
            
                            switch (paths[3]) {
                                case 'db':
                                    validateUserForMgmtReadAPI(function(){
                                        if (!params.qstring.collection) {
                                            common.returnMessage(params, 400, 'Missing parameter "collection"');
                                            return false;
                                        }
                                        if(typeof params.qstring.query === "string"){
                                            try{
                                                params.qstring.query = JSON.parse(params.qstring.query, reviver);
                                            }
                                            catch(ex){params.qstring.query = null;}
                                        }
                                        if(typeof params.qstring.projection === "string"){
                                            try{
                                                params.qstring.projection = JSON.parse(params.qstring.projection);
                                            }
                                            catch(ex){params.qstring.projection = null;}
                                        }
                                        if(typeof params.qstring.sort === "string"){
                                            try{
                                                params.qstring.sort = JSON.parse(params.qstring.sort);
                                            }
                                            catch(ex){params.qstring.sort = null;}
                                        }
                                        countlyApi.data.exports.fromDatabase({
                                            db: (params.qstring.db === "countly_drill") ? common.drillDb : common.db,
                                            params: params,
                                            collection: params.qstring.collection,
                                            query: params.qstring.query,
                                            projection: params.qstring.projection,
                                            sort: params.qstring.sort,
                                            limit: params.qstring.limit,
                                            skip: params.qstring.skip,
                                            type: params.qstring.type,
                                            filename: params.qstring.filename
                                        });
                                    }, params);
                                    break;
                                case 'request':
                                    validateUserForMgmtReadAPI(function(){
                                        if (!params.qstring.path) {
                                            common.returnMessage(params, 400, 'Missing parameter "path"');
                                            return false;
                                        }
                                        if(typeof params.qstring.data === "string"){
                                            try{
                                                params.qstring.data = JSON.parse(params.qstring.data);
                                            }
                                            catch(ex){
                                                params.qstring.data = {};
                                            }
                                        }
                                        countlyApi.data.exports.fromRequest({
                                            params: params,
                                            path:params.qstring.path,
                                            data:params.qstring.data,
                                            method:params.qstring.method,
                                            post:params.qstring.post,
                                            prop:params.qstring.prop,
                                            type: params.qstring.type,
                                            filename: params.qstring.filename
                                        });
                                    }, params);
                                    break;
                                case 'data':
                                    validateUserForMgmtReadAPI(function(){
                                        if (!params.qstring.data) {
                                            common.returnMessage(params, 400, 'Missing parameter "data"');
                                            return false;
                                        }
                                        if(typeof params.qstring.data === "string" && !params.qstring.raw){
                                            try{
                                                params.qstring.data = JSON.parse(params.qstring.data);
                                            }
                                            catch(ex){
                                                common.returnMessage(params, 400, 'Incorrect parameter "data"');
                                                return false;
                                            }
                                        }
                                        countlyApi.data.exports.fromData(params.qstring.data, {
                                            params: params,
                                            type: params.qstring.type,
                                            filename: params.qstring.filename
                                        });
                                    }, params);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/ping':
                        {
                            common.db.collection("plugins").findOne({_id:"plugins"}, {_id:1}, function(err, result){
                                if(err)
                                    common.returnMessage(params, 404, 'DB Error');
                                else
                                    common.returnMessage(params, 200, 'Success');
                            });
                            break;
                        }
                        case '/o/token':
                        {
                            var ttl, multi;
                            if(params.qstring.ttl)
                               ttl = parseInt(params.qstring.ttl);
                            else
                                ttl = 1800;
                            if(params.qstring.multi)
                               multi = true;
                            else
                                multi = false;
                            validateUserForDataReadAPI(params, function(){
                                authorize.save({db:common.db, ttl:ttl, multi:multi, owner:params.member._id+"", app:params.app_id+"", callback:function(err, token){
                                    if(err){
                                        common.returnMessage(params, 404, 'DB Error');
                                    }
                                    else{
                                        common.returnMessage(params, 200, token);
                                    }
                                }});
                            });
                            break;
                        }
                        case '/o':
                        {
                            if (!params.qstring.app_id) {
                                common.returnMessage(params, 400, 'Missing parameter "app_id"');
                                return false;
                            }
            
                            switch (params.qstring.method) {
                                case 'total_users':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTotalUsersObj, params.qstring.metric || 'users');
                                    break;
                                case 'get_period_obj':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.getPeriodObj, 'users');
                                    break;
                                case 'locations':
                                case 'sessions':
                                case 'users':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTimeObj, 'users');
                                    break;
                                case 'app_versions':
                                case 'device_details':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTimeObj, 'device_details');
                                    break;
                                case 'devices':
                                case 'carriers':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTimeObj, params.qstring.method);
                                    break;
                                case 'cities':
                                    if (plugins.getConfig("api").city_data !== false) {
                                        validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTimeObj, params.qstring.method);
                                    } else {
                                        common.returnOutput(params, {});
                                    }
                                    break;
                                case 'events':
                                    if (params.qstring.events) {
                                        try {
                                            params.qstring.events = JSON.parse(params.qstring.events);
                                        } catch (SyntaxError) {
                                            console.log('Parse events array failed', params.qstring.events, req.url, req.body);
                                        }
            
                                        validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchMergedEventData);
                                    } else {
                                        validateUserForDataReadAPI(params, countlyApi.data.fetch.prefetchEventData, params.qstring.method);
                                    }
                                    break;
                                case 'get_events':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchCollection, 'events');
                                    break;
                                case 'all_apps':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchAllApps);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid method');
                                    break;
                            }
            
                            break;
                        }
                        case '/o/analytics':
                        {
                            if (!params.qstring.app_id) {
                                common.returnMessage(params, 400, 'Missing parameter "app_id"');
                                return false;
                            }
            
                            switch (paths[3]) {
                                case 'dashboard':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchDashboard);
                                    break;
                                case 'countries':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchCountries);
                                    break;
                                case 'sessions':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchSessions);
                                    break;
                                case 'metric':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchMetric);
                                    break;
                                case 'tops':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchTops);
                                    break;
                                case 'loyalty':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchLoyalty);
                                    break;
                                case 'frequency':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchFrequency);
                                    break;
                                case 'durations':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchDurations);
                                    break;
                                case 'events':
                                    validateUserForDataReadAPI(params, countlyApi.data.fetch.fetchEvents);
                                    break;
                                default:
                                    if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin}))
                                        common.returnMessage(params, 400, 'Invalid path, must be one of /dashboard or /countries');
                                    break;
                            }
            
                            break;
                        }
                        default:
                            if(!plugins.dispatch(apiPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, validateUserForWriteAPI:validateUserForWriteAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin})){
                                if(!plugins.dispatch(params.fullPath, {params:params, validateUserForDataReadAPI:validateUserForDataReadAPI, validateUserForMgmtReadAPI:validateUserForMgmtReadAPI, validateUserForWriteAPI:validateUserForWriteAPI, paths:paths, validateUserForDataWriteAPI:validateUserForDataWriteAPI, validateUserForGlobalAdmin:validateUserForGlobalAdmin})){
                                    common.returnMessage(params, 400, 'Invalid path');
                                }
                            }
                    }
                } else {
                    if (plugins.getConfig("api").safe && !params.res.finished) {
                        common.returnMessage(params, 200, 'Request ignored: ' + params.cancelRequest);
                    }
                    common.log("request").i('Request ignored: ' + params.cancelRequest, params.req.url, params.req.body);
                }
            };
            
            if(req.method.toLowerCase() == 'post'){
                var form = new formidable.IncomingForm();
                req.body = '';

                req.on('data', function (data) {
                    req.body += data;
                });
    
                form.parse(req, function(err, fields, files) {
                    params.files = files;
                    for(var i in fields){
                        params.qstring[i] = fields[i];
                    }
                    if(!params.apiPath)
                        processRequest();
                });
            }
            else if (req.method === 'OPTIONS') {
                var headers = {};
                headers["Access-Control-Allow-Origin"] = "*";
                headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS";
                headers["Access-Control-Allow-Headers"] = "countly-token";
                res.writeHead(200, headers);
                res.end();
            }
            else
                //attempt process GET request
                processRequest();
        }, true);

    }).listen(common.config.api.port, common.config.api.host || '').timeout = common.config.api.timeout || 120000;

    plugins.loadConfigs(common.db);
}
