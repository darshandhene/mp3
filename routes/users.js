var User = require('../models/user');
var Task = require('../models/task');
var helpers = require('./helpers');

function requireText(value, label) {
    if (value === undefined || value === null || value === '') {
        throw helpers.HttpError(400, label + ' is required');
    }
    if (typeof value !== 'string') {
        throw helpers.HttpError(400, label + ' must be a string');
    }
    return value;
}

function parsePendingTasks(value) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value)) {
        throw helpers.HttpError(400, 'Pending tasks must be an array');
    }
    var ids = [];
    var seen = {};
    for (var i = 0; i < value.length; i++) {
        var entry = value[i];
        if (!helpers.isObjectId(entry)) {
            throw helpers.HttpError(400, 'Invalid task id in pending tasks');
        }
        var id = helpers.normalizeId(entry);
        if (seen[id]) {
            continue;
        }
        seen[id] = true;
        ids.push(id);
    }
    return ids;
}

function parseUserBody(body) {
    body = body || {};
    return {
        name: requireText(body.name, 'Name'),
        email: requireText(body.email, 'Email'),
        pendingTasks: parsePendingTasks(body.pendingTasks)
    };
}

async function assertEmailAvailable(email, currentId) {
    var owner = await User.findOne({ email: email });
    if (owner && owner._id.toString() !== currentId) {
        throw helpers.HttpError(400, 'A user with this email already exists');
    }
}

// Format is checked by the caller. Existence is 404, then completed tasks are 400.
async function assertPendingTasksOpen(ids) {
    if (ids.length === 0) {
        return;
    }
    var tasks = await Task.find({ _id: { $in: ids } });
    if (tasks.length !== ids.length) {
        throw helpers.HttpError(404, 'Task not found');
    }
    for (var i = 0; i < tasks.length; i++) {
        if (tasks[i].completed) {
            throw helpers.HttpError(400, 'Completed tasks cannot be pending');
        }
    }
}

async function syncUserTasks(userId, name, oldIds, newIds) {
    var removed = oldIds.filter(function (id) {
        return newIds.indexOf(id) === -1;
    });

    if (removed.length > 0) {
        await Task.updateMany(
            { _id: { $in: removed } },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
    }

    if (newIds.length > 0) {
        await Task.updateMany(
            { _id: { $in: newIds } },
            { $set: { assignedUser: userId, assignedUserName: name } }
        );
        await User.updateMany(
            { _id: { $ne: userId }, pendingTasks: { $in: newIds } },
            { $pull: { pendingTasks: { $in: newIds } } }
        );
    }

    await Task.updateMany(
        { assignedUser: userId },
        { $set: { assignedUserName: name } }
    );
}

module.exports = function (router) {
    router.route('/users')
        .get(helpers.wrap(async function (req, res) {
            var parsed = helpers.parseListQuery(req.query);
            var data = await helpers.runList(User, parsed);
            helpers.send(res, 200, 'OK', data);
        }))
        .post(helpers.wrap(async function (req, res) {
            var parsed = parseUserBody(req.body);
            await assertEmailAvailable(parsed.email, null);
            await assertPendingTasksOpen(parsed.pendingTasks);

            var user = new User({
                name: parsed.name,
                email: parsed.email,
                pendingTasks: parsed.pendingTasks,
                dateCreated: new Date()
            });
            await user.save();
            await syncUserTasks(user._id.toString(), user.name, [], parsed.pendingTasks);
            helpers.send(res, 201, 'OK', user);
        }));

    router.route('/users/:id')
        .get(helpers.wrap(async function (req, res) {
            var existing = await helpers.findDocument(User, req.params.id);
            if (!existing) {
                throw helpers.HttpError(404, 'User not found');
            }
            var select = helpers.parseSelect(req.query.select);
            var user = existing;
            if (select && Object.keys(select).length > 0) {
                user = await User.findById(existing._id).select(select);
            }
            helpers.send(res, 200, 'OK', user);
        }))
        .put(helpers.wrap(async function (req, res) {
            var user = await helpers.findDocument(User, req.params.id);
            if (!user) {
                throw helpers.HttpError(404, 'User not found');
            }

            var parsed = parseUserBody(req.body);
            await assertEmailAvailable(parsed.email, user._id.toString());
            await assertPendingTasksOpen(parsed.pendingTasks);

            var oldIds = (user.pendingTasks || []).map(function (id) {
                return id.toString();
            });
            user.name = parsed.name;
            user.email = parsed.email;
            user.pendingTasks = parsed.pendingTasks;
            await user.save();
            await syncUserTasks(user._id.toString(), parsed.name, oldIds, parsed.pendingTasks);
            helpers.send(res, 200, 'OK', user);
        }))
        .delete(helpers.wrap(async function (req, res) {
            var user = await helpers.findDocument(User, req.params.id);
            if (!user) {
                throw helpers.HttpError(404, 'User not found');
            }
            await Task.updateMany(
                { assignedUser: user._id.toString() },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
            await user.deleteOne();
            res.status(204).end();
        }));

    return router;
};
