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

function parseDeadline(value) {
    if (value === undefined || value === null || value === '') {
        throw helpers.HttpError(400, 'Deadline is required');
    }
    if (typeof value !== 'string') {
        throw helpers.HttpError(400, 'Deadline must be a valid date');
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw helpers.HttpError(400, 'Deadline must be a valid date');
    }
    return date;
}

function parseTaskBody(body) {
    body = body || {};
    var description = body.description;
    if (description === undefined) {
        description = '';
    } else if (typeof description !== 'string') {
        throw helpers.HttpError(400, 'Description must be a string');
    }

    var completed = body.completed;
    if (completed === undefined) {
        completed = false;
    } else if (typeof completed !== 'boolean') {
        throw helpers.HttpError(400, 'Completed must be a boolean');
    }

    var assignedUser = body.assignedUser;
    if (assignedUser === undefined) {
        assignedUser = '';
    } else if (typeof assignedUser !== 'string') {
        throw helpers.HttpError(400, 'Assigned user must be a string');
    } else if (assignedUser !== '' && !helpers.isObjectId(assignedUser)) {
        throw helpers.HttpError(400, 'Invalid user id');
    } else if (assignedUser !== '') {
        assignedUser = helpers.normalizeId(assignedUser);
    }

    var assignedUserName = body.assignedUserName;
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw helpers.HttpError(400, 'Assigned user name must be a string');
    }

    return {
        name: requireText(body.name, 'Name'),
        description: description,
        deadline: parseDeadline(body.deadline),
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

async function resolveAssignee(parsed) {
    if (parsed.assignedUser === '') {
        if (parsed.assignedUserName !== undefined && parsed.assignedUserName !== 'unassigned') {
            throw helpers.HttpError(400, 'Assigned user name does not match the assigned user');
        }
        return { id: '', name: 'unassigned' };
    }

    var user = await helpers.findDocument(User, parsed.assignedUser);
    if (!user) {
        throw helpers.HttpError(404, 'Assigned user not found');
    }
    if (parsed.assignedUserName !== undefined && parsed.assignedUserName !== user.name) {
        throw helpers.HttpError(400, 'Assigned user name does not match the assigned user');
    }
    return { id: user._id.toString(), name: user.name };
}

async function syncTaskAssignment(taskId, previousUserId, nextUserId, completed) {
    if (previousUserId && previousUserId !== nextUserId) {
        await User.updateOne(
            { _id: previousUserId },
            { $pull: { pendingTasks: taskId } }
        );
    }
    if (!nextUserId) {
        return;
    }
    if (completed) {
        await User.updateOne(
            { _id: nextUserId },
            { $pull: { pendingTasks: taskId } }
        );
    } else {
        await User.updateOne(
            { _id: nextUserId },
            { $addToSet: { pendingTasks: taskId } }
        );
    }
}

function applyTaskFields(task, parsed, assignee) {
    task.name = parsed.name;
    task.description = parsed.description;
    task.deadline = parsed.deadline;
    task.completed = parsed.completed;
    task.assignedUser = assignee.id;
    task.assignedUserName = assignee.name;
}

module.exports = function (router) {
    router.route('/tasks')
        .get(helpers.wrap(async function (req, res) {
            var parsed = helpers.parseListQuery(req.query, 100);
            var data = await helpers.runList(Task, parsed);
            helpers.send(res, 200, 'OK', data);
        }))
        .post(helpers.wrap(async function (req, res) {
            var parsed = parseTaskBody(req.body);
            var assignee = await resolveAssignee(parsed);
            var task = new Task({
                name: parsed.name,
                description: parsed.description,
                deadline: parsed.deadline,
                completed: parsed.completed,
                assignedUser: assignee.id,
                assignedUserName: assignee.name,
                dateCreated: new Date()
            });
            await task.save();
            await syncTaskAssignment(task._id.toString(), '', assignee.id, parsed.completed);
            helpers.send(res, 201, 'OK', task);
        }));

    router.route('/tasks/:id')
        .get(helpers.wrap(async function (req, res) {
            var existing = await helpers.findDocument(Task, req.params.id);
            if (!existing) {
                throw helpers.HttpError(404, 'Task not found');
            }
            var select = helpers.parseSelect(req.query.select);
            var task = existing;
            if (select && Object.keys(select).length > 0) {
                task = await Task.findById(existing._id).select(select);
            }
            helpers.send(res, 200, 'OK', task);
        }))
        .put(helpers.wrap(async function (req, res) {
            var task = await helpers.findDocument(Task, req.params.id);
            if (!task) {
                throw helpers.HttpError(404, 'Task not found');
            }

            var parsed = parseTaskBody(req.body);
            var assignee = await resolveAssignee(parsed);
            var previousUserId = task.assignedUser || '';
            applyTaskFields(task, parsed, assignee);
            await task.save();
            await syncTaskAssignment(task._id.toString(), previousUserId, assignee.id, parsed.completed);
            helpers.send(res, 200, 'OK', task);
        }))
        .delete(helpers.wrap(async function (req, res) {
            var task = await helpers.findDocument(Task, req.params.id);
            if (!task) {
                throw helpers.HttpError(404, 'Task not found');
            }
            if (task.assignedUser) {
                await User.updateOne(
                    { _id: task.assignedUser },
                    { $pull: { pendingTasks: task._id.toString() } }
                );
            }
            await task.deleteOne();
            res.status(204).end();
        }));

    return router;
};
