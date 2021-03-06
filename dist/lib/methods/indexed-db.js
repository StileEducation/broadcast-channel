'use strict';

Object.defineProperty(exports, "__esModule", {
    value: true
});
exports.type = undefined;
exports.getIdb = getIdb;
exports.createDatabase = createDatabase;
exports.writeMessage = writeMessage;
exports.getAllMessages = getAllMessages;
exports.getMessagesHigherThen = getMessagesHigherThen;
exports.removeMessageById = removeMessageById;
exports.getOldMessages = getOldMessages;
exports.cleanOldMessages = cleanOldMessages;
exports.create = create;
exports.close = close;
exports.postMessage = postMessage;
exports.onMessage = onMessage;
exports.canBeUsed = canBeUsed;
exports.averageResponseTime = averageResponseTime;

var _util = require('../util.js');

var _options = require('../options');

/**
 * this method uses indexeddb to store the messages
 * There is currently no observerAPI for idb
 * @link https://github.com/w3c/IndexedDB/issues/51
 */

var isNode = require('detect-node');

var DB_PREFIX = 'pubkey.broadcast-channel-0-';
var OBJECT_STORE_ID = 'messages';

var type = exports.type = 'idb';

function getIdb() {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    if (typeof mozIndexedDB !== 'undefined') return mozIndexedDB;
    if (typeof webkitIndexedDB !== 'undefined') return webkitIndexedDB;
    if (typeof msIndexedDB !== 'undefined') return msIndexedDB;

    return false;
}

function createDatabase(channelName) {
    var IndexedDB = getIdb();

    // create table
    var dbName = DB_PREFIX + channelName;
    var openRequest = IndexedDB.open(dbName, 1);

    openRequest.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        db.createObjectStore(OBJECT_STORE_ID, {
            keyPath: 'id',
            autoIncrement: true
        });
    };
    var dbPromise = new Promise(function (res, rej) {
        openRequest.onerror = function (ev) {
            return rej(ev);
        };
        openRequest.onsuccess = function () {
            res(openRequest.result);
        };
    });

    return dbPromise;
}

/**
 * writes the new message to the database
 * so other readers can find it
 */
function writeMessage(db, readerUuid, messageJson) {
    var time = new Date().getTime();
    var writeObject = {
        uuid: readerUuid,
        time: time,
        data: messageJson
    };

    var transaction = db.transaction([OBJECT_STORE_ID], 'readwrite');

    return new Promise(function (res, rej) {
        transaction.oncomplete = function () {
            return res();
        };
        transaction.onerror = function (ev) {
            return rej(ev);
        };

        var objectStore = transaction.objectStore(OBJECT_STORE_ID);
        objectStore.add(writeObject);
    });
}

function getAllMessages(db) {
    var objectStore = db.transaction(OBJECT_STORE_ID).objectStore(OBJECT_STORE_ID);
    var ret = [];
    return new Promise(function (res) {
        objectStore.openCursor().onsuccess = function (ev) {
            var cursor = ev.target.result;
            if (cursor) {
                ret.push(cursor.value);
                //alert("Name for SSN " + cursor.key + " is " + cursor.value.name);
                cursor['continue']();
            } else {
                res(ret);
            }
        };
    });
}

function getMessagesHigherThen(db, lastCursorId) {
    var objectStore = db.transaction(OBJECT_STORE_ID).objectStore(OBJECT_STORE_ID);
    var ret = [];
    var keyRangeValue = IDBKeyRange.bound(lastCursorId + 1, Infinity);
    return new Promise(function (res) {
        objectStore.openCursor(keyRangeValue).onsuccess = function (ev) {
            var cursor = ev.target.result;
            if (cursor) {
                ret.push(cursor.value);
                //alert("Name for SSN " + cursor.key + " is " + cursor.value.name);
                cursor['continue']();
            } else {
                res(ret);
            }
        };
    });
}

function removeMessageById(db, id) {
    var request = db.transaction([OBJECT_STORE_ID], 'readwrite').objectStore(OBJECT_STORE_ID)['delete'](id);
    return new Promise(function (res) {
        request.onsuccess = function () {
            return res();
        };
    });
}

function getOldMessages(db, ttl) {
    var olderThen = new Date().getTime() - ttl;
    var objectStore = db.transaction(OBJECT_STORE_ID).objectStore(OBJECT_STORE_ID);
    var ret = [];
    return new Promise(function (res) {
        objectStore.openCursor().onsuccess = function (ev) {
            var cursor = ev.target.result;
            if (cursor) {
                var msgObk = cursor.value;
                if (msgObk.time < olderThen) {
                    ret.push(msgObk);
                    //alert("Name for SSN " + cursor.key + " is " + cursor.value.name);
                    cursor['continue']();
                } else {
                    // no more old messages,
                    res(ret);
                    return;
                }
            } else {
                res(ret);
            }
        };
    });
}

function cleanOldMessages(db, ttl) {
    return getOldMessages(db, ttl).then(function (tooOld) {
        return Promise.all(tooOld.map(function (msgObj) {
            return removeMessageById(db, msgObj.id);
        }));
    });
}

function create(channelName, options) {
    options = (0, _options.fillOptionsWithDefaults)(options);

    var uuid = (0, _util.randomToken)(10);

    return createDatabase(channelName).then(function (db) {
        var state = {
            closed: false,
            lastCursorId: 0,
            channelName: channelName,
            options: options,
            uuid: uuid,
            // contains all messages that have been emitted before
            emittedMessagesIds: new Set(),
            messagesCallback: null,
            readQueuePromises: [],
            db: db
        };

        /**
         * if service-workers are used,
         * we have no 'storage'-event if they post a message,
         * therefore we also have to set an interval
         */
        _readLoop(state);

        return state;
    });
}

function _readLoop(state) {
    if (state.closed) return;

    return readNewMessages(state).then(function () {
        return (0, _util.sleep)(state.options.idb.fallbackInterval);
    }).then(function () {
        return _readLoop(state);
    });
}

/**
 * reads all new messages from the database and emits them
 */
function readNewMessages(state) {
    return getMessagesHigherThen(state.db, state.lastCursorId).then(function (newerMessages) {
        var useMessages = newerMessages.map(function (msgObj) {
            if (msgObj.id > state.lastCursorId) {
                state.lastCursorId = msgObj.id;
            }
            return msgObj;
        }).filter(function (msgObj) {
            return msgObj.uuid !== state.uuid;
        }) // not send by own
        .filter(function (msgObj) {
            return !state.emittedMessagesIds.has(msgObj.id);
        }) // not already emitted
        .filter(function (msgObj) {
            return msgObj.time >= state.messagesCallbackTime;
        }) // not older then onMessageCallback
        .sort(function (msgObjA, msgObjB) {
            return msgObjA.time - msgObjB.time;
        }); // sort by time


        useMessages.forEach(function (msgObj) {
            if (state.messagesCallback) {
                state.emittedMessagesIds.add(msgObj.id);
                setTimeout(function () {
                    return state.emittedMessagesIds['delete'](msgObj.id);
                }, state.options.idb.ttl * 2);

                state.messagesCallback(msgObj.data);
            }
        });

        return Promise.resolve();
    });
}

function close(channelState) {
    channelState.closed = true;
    channelState.db.close();
}

function postMessage(channelState, messageJson) {
    return writeMessage(channelState.db, channelState.uuid, messageJson).then(function () {
        if ((0, _util.randomInt)(0, 10) === 0) {
            /* await (do not await) */cleanOldMessages(channelState.db, channelState.options.idb.ttl);
        }
    });
}

function onMessage(channelState, fn, time) {
    channelState.messagesCallbackTime = time;
    channelState.messagesCallback = fn;
    readNewMessages(channelState);
}

function canBeUsed() {
    if (isNode) return false;
    var idb = getIdb();

    if (!idb) return false;
    return true;
};

function averageResponseTime(options) {
    return options.idb.fallbackInterval * 1.5;
}