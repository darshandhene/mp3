var mongoose = require('mongoose');

var ID_RE = /^[a-fA-F0-9]{24}$/;

function HttpError(status, message) {
    var error = new Error(message);
    error.status = status;
    error.isHttp = true;
    return error;
}

function send(res, status, message, data) {
    return res.status(status).json({ message: message, data: data });
}

function handleError(res, err) {
    if (err && err.isHttp) {
        return send(res, err.status, err.message, null);
    }
    if (err && err.code === 11000) {
        return send(res, 400, 'A user with this email already exists', null);
    }
    if (err && (err.name === 'CastError' || err.name === 'ValidationError')) {
        return send(res, 400, 'Invalid request', null);
    }
    console.error(err);
    return send(res, 500, 'Internal server error', null);
}

function wrap(fn) {
    return function (req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(function (err) {
            handleError(res, err);
        });
    };
}

function isObjectId(id) {
    return typeof id === 'string' && ID_RE.test(id);
}

function normalizeId(id) {
    return new mongoose.Types.ObjectId(id).toString();
}

function findDocument(Model, id) {
    if (!isObjectId(id)) {
        return Promise.resolve(null);
    }
    return Model.findById(id);
}

function parseJsonObject(value, name) {
    if (value === undefined) {
        return undefined;
    }
    var parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch (err) {
            throw HttpError(400, 'Invalid ' + name + ' parameter');
        }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw HttpError(400, 'Invalid ' + name + ' parameter');
    }
    return parsed;
}

function parseSelect(value) {
    var obj = parseJsonObject(value, 'select');
    if (obj === undefined) {
        return undefined;
    }
    var mode = null;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var flag = obj[key];
        if (flag !== 0 && flag !== 1) {
            throw HttpError(400, 'Invalid select parameter');
        }
        if (key === '_id') {
            continue;
        }
        var keyMode = flag === 1 ? 'include' : 'exclude';
        if (mode && mode !== keyMode) {
            throw HttpError(400, 'Invalid select parameter');
        }
        mode = keyMode;
    }
    return obj;
}

function parseSort(value) {
    var obj = parseJsonObject(value, 'sort');
    if (obj === undefined) {
        return undefined;
    }
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
        if (obj[keys[i]] !== 1 && obj[keys[i]] !== -1) {
            throw HttpError(400, 'Invalid sort parameter');
        }
    }
    return obj;
}

function parseWhere(value) {
    var obj = parseJsonObject(value, 'where');
    return obj === undefined ? {} : obj;
}

function parseNonNegativeInt(value, name) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
        throw HttpError(400, 'Invalid ' + name + ' parameter');
    }
    return Number(value);
}

function parseCount(value) {
    if (value === undefined || value === 'false') {
        return false;
    }
    if (value === 'true') {
        return true;
    }
    throw HttpError(400, 'Invalid count parameter');
}

function parseListQuery(query, defaultLimit) {
    var limit = parseNonNegativeInt(query.limit, 'limit');
    if (limit === undefined) {
        limit = defaultLimit;
    }
    return {
        where: parseWhere(query.where),
        sort: parseSort(query.sort),
        select: parseSelect(query.select),
        skip: parseNonNegativeInt(query.skip, 'skip'),
        limit: limit,
        count: parseCount(query.count)
    };
}

function runList(Model, parsed) {
    if (parsed.count) {
        return Model.countDocuments(parsed.where).catch(function (err) {
            if (err.name === 'CastError') {
                throw HttpError(400, 'Invalid query');
            }
            throw err;
        });
    }

    var cursor = Model.find(parsed.where);
    if (parsed.select && Object.keys(parsed.select).length > 0) {
        cursor = cursor.select(parsed.select);
    }
    if (parsed.sort && Object.keys(parsed.sort).length > 0) {
        cursor = cursor.sort(parsed.sort);
    }
    if (parsed.skip !== undefined) {
        cursor = cursor.skip(parsed.skip);
    }
    if (parsed.limit !== undefined) {
        cursor = cursor.limit(parsed.limit);
    }
    return cursor.exec().catch(function (err) {
        if (err.name === 'CastError') {
            throw HttpError(400, 'Invalid query');
        }
        throw err;
    });
}

module.exports = {
    HttpError: HttpError,
    send: send,
    handleError: handleError,
    wrap: wrap,
    isObjectId: isObjectId,
    normalizeId: normalizeId,
    findDocument: findDocument,
    parseSelect: parseSelect,
    parseListQuery: parseListQuery,
    runList: runList
};
