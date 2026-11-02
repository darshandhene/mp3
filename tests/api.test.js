process.env.NODE_ENV = 'test';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/user');
const Task = require('../models/task');

let mongod;
let server;
let base;

function q(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        search.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return '?' + search.toString();
}

async function request(method, path, body) {
    const response = await fetch(base + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let parsed = null;
    if (text) {
        parsed = JSON.parse(text);
    }
    return { status: response.status, body: parsed, text };
}

function assertEnvelope(response) {
    assert.equal(typeof response.body.message, 'string');
    assert.ok(response.body.message.length > 0);
    assert.deepEqual(Object.keys(response.body).sort(), ['data', 'message']);
    assert.doesNotMatch(response.body.message, /mongoose|mongodb|cast to|validationerror/i);
}

describe('mp3 api', { timeout: 180000 }, () => {
    before(async () => {
        mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());
        const app = require('../server');
        await User.init();
        await Task.init();
        server = app.listen(0);
        base = `http://127.0.0.1:${server.address().port}/api`;
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await mongoose.disconnect();
        if (mongod) {
            await mongod.stop();
        }
    });

    beforeEach(async () => {
        await User.deleteMany({});
        await Task.deleteMany({});
    });

    it('creates users and tasks with defaults and rejects invalid bodies', async () => {
        const missing = await request('POST', '/users', { email: 'a@b.com' });
        assert.equal(missing.status, 400);
        assertEnvelope(missing);

        const badType = await request('POST', '/users', { name: 5, email: 'a@b.com' });
        assert.equal(badType.status, 400);

        const user = await request('POST', '/users', { name: 'Ada', email: 'ada@b.com' });
        assert.equal(user.status, 201);
        assertEnvelope(user);
        assert.equal(user.body.data.name, 'Ada');
        assert.equal(user.body.data.email, 'ada@b.com');
        assert.deepEqual(user.body.data.pendingTasks, []);
        assert.equal(typeof user.body.data._id, 'string');
        assert.ok(Math.abs(new Date(user.body.data.dateCreated).getTime() - Date.now()) < 60_000);
        assert.equal(user.body.data.__v, undefined);

        const stamped = await request('POST', '/users', {
            name: 'Grace',
            email: 'grace@b.com',
            dateCreated: '1999-01-01T00:00:00.000Z'
        });
        assert.equal(stamped.status, 201);
        assert.notEqual(stamped.body.data.dateCreated.slice(0, 4), '1999');

        const duplicate = await request('POST', '/users', { name: 'Other', email: 'ada@b.com' });
        assert.equal(duplicate.status, 400);
        assert.equal(await User.countDocuments({ email: 'ada@b.com' }), 1);

        const taskMissing = await request('POST', '/tasks', { name: 'Write tests' });
        assert.equal(taskMissing.status, 400);

        const task = await request('POST', '/tasks', {
            name: 'Write tests',
            deadline: '2026-11-03T18:00:00.000Z',
            dateCreated: '1999-01-01T00:00:00.000Z'
        });
        assert.equal(task.status, 201);
        assertEnvelope(task);
        assert.equal(task.body.data.description, '');
        assert.equal(task.body.data.completed, false);
        assert.equal(task.body.data.assignedUser, '');
        assert.equal(task.body.data.assignedUserName, 'unassigned');
        assert.equal(new Date(task.body.data.deadline).toISOString(), '2026-11-03T18:00:00.000Z');
        assert.notEqual(task.body.data.dateCreated.slice(0, 4), '1999');
        assert.equal(await Task.countDocuments({}), 1);
    });

    it('keeps user and task references consistent', async () => {
        const ada = (await request('POST', '/users', { name: 'Ada', email: 'ada@b.com' })).body.data;
        const grace = (await request('POST', '/users', { name: 'Grace', email: 'grace@b.com' })).body.data;
        const loose = (await request('POST', '/tasks', {
            name: 'Loose',
            deadline: '2026-12-01T00:00:00.000Z'
        })).body.data;

        const badId = await request('POST', '/tasks', {
            name: 'Nope',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: 'not-an-id'
        });
        assert.equal(badId.status, 400);
        assert.equal(await Task.countDocuments({ name: 'Nope' }), 0);

        const missingUser = await request('POST', '/tasks', {
            name: 'Nope',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: '507f1f77bcf86cd799439011',
            assignedUserName: 'Nobody'
        });
        assert.equal(missingUser.status, 404);
        assert.equal(await Task.countDocuments({ name: 'Nope' }), 0);

        const wrongName = await request('POST', '/tasks', {
            name: 'Nope',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: ada._id,
            assignedUserName: 'Grace'
        });
        assert.equal(wrongName.status, 400);
        assert.equal(await Task.countDocuments({ name: 'Nope' }), 0);

        const assigned = await request('POST', '/tasks', {
            name: 'Assigned',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: ada._id
        });
        assert.equal(assigned.status, 201);
        assert.equal(assigned.body.data.assignedUser, ada._id);
        assert.equal(assigned.body.data.assignedUserName, 'Ada');

        const done = await request('POST', '/tasks', {
            name: 'Done',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: true,
            assignedUser: ada._id,
            assignedUserName: 'Ada'
        });
        assert.equal(done.status, 201);

        let adaDoc = (await request('GET', '/users/' + ada._id)).body.data;
        assert.deepEqual(adaDoc.pendingTasks, [assigned.body.data._id]);

        const completedInList = await request('PUT', '/users/' + ada._id, {
            name: 'Ada',
            email: 'ada@b.com',
            pendingTasks: [assigned.body.data._id, done.body.data._id]
        });
        assert.equal(completedInList.status, 400);
        adaDoc = (await request('GET', '/users/' + ada._id)).body.data;
        assert.equal(adaDoc.name, 'Ada');
        assert.deepEqual(adaDoc.pendingTasks, [assigned.body.data._id]);

        const renamed = await request('PUT', '/users/' + ada._id, {
            name: 'Ada Lovelace',
            email: 'ada@b.com',
            pendingTasks: [assigned.body.data._id]
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.body.data.dateCreated, adaDoc.dateCreated);

        const renamedAssigned = (await request('GET', '/tasks/' + assigned.body.data._id)).body.data;
        const renamedDone = (await request('GET', '/tasks/' + done.body.data._id)).body.data;
        assert.equal(renamedAssigned.assignedUserName, 'Ada Lovelace');
        assert.equal(renamedDone.assignedUser, ada._id);
        assert.equal(renamedDone.assignedUserName, 'Ada Lovelace');
        assert.equal(renamedDone.completed, true);

        const moved = await request('PUT', '/users/' + grace._id, {
            name: 'Grace',
            email: 'grace@b.com',
            pendingTasks: [assigned.body.data._id, loose._id]
        });
        assert.equal(moved.status, 200);
        const movedTask = (await request('GET', '/tasks/' + assigned.body.data._id)).body.data;
        const movedLoose = (await request('GET', '/tasks/' + loose._id)).body.data;
        assert.equal(movedTask.assignedUser, grace._id);
        assert.equal(movedTask.assignedUserName, 'Grace');
        assert.equal(movedLoose.assignedUser, grace._id);
        assert.deepEqual((await request('GET', '/users/' + grace._id)).body.data.pendingTasks.sort(), [assigned.body.data._id, loose._id].sort());
        assert.deepEqual((await request('GET', '/users/' + ada._id)).body.data.pendingTasks, []);

        const cleared = await request('PUT', '/users/' + grace._id, {
            name: 'Grace Hopper',
            email: 'grace@b.com'
        });
        assert.equal(cleared.status, 200);
        assert.deepEqual(cleared.body.data.pendingTasks, []);
        const unassigned = (await request('GET', '/tasks/' + loose._id)).body.data;
        assert.equal(unassigned.assignedUser, '');
        assert.equal(unassigned.assignedUserName, 'unassigned');
        const stillDone = (await request('GET', '/tasks/' + done.body.data._id)).body.data;
        assert.equal(stillDone.assignedUserName, 'Ada Lovelace');

        const reopened = await request('PUT', '/tasks/' + done.body.data._id, {
            name: 'Done',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: false,
            assignedUser: ada._id
        });
        assert.equal(reopened.status, 200);
        assert.equal(reopened.body.data.assignedUserName, 'Ada Lovelace');
        assert.deepEqual((await request('GET', '/users/' + ada._id)).body.data.pendingTasks, [done.body.data._id]);

        const finished = await request('PUT', '/tasks/' + done.body.data._id, {
            name: 'Done',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: true,
            assignedUser: ada._id,
            assignedUserName: 'Ada Lovelace'
        });
        assert.equal(finished.status, 200);
        assert.equal(finished.body.data.assignedUser, ada._id);
        assert.deepEqual((await request('GET', '/users/' + ada._id)).body.data.pendingTasks, []);

        const givenToGrace = await request('PUT', '/tasks/' + done.body.data._id, {
            name: 'Done',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: true,
            assignedUser: grace._id,
            assignedUserName: 'Grace Hopper'
        });
        assert.equal(givenToGrace.status, 200);
        assert.deepEqual((await request('GET', '/users/' + grace._id)).body.data.pendingTasks, []);
        assert.equal((await request('GET', '/tasks/' + done.body.data._id)).body.data.assignedUser, grace._id);

        const pendingAgain = await request('PUT', '/tasks/' + done.body.data._id, {
            name: 'Done',
            description: 'ship it',
            deadline: '2026-12-02T00:00:00.000Z',
            completed: false,
            assignedUser: grace._id,
            assignedUserName: 'Grace Hopper'
        });
        assert.equal(pendingAgain.status, 200);
        assert.deepEqual((await request('GET', '/users/' + grace._id)).body.data.pendingTasks, [done.body.data._id]);

        const replaced = await request('PUT', '/tasks/' + done.body.data._id, {
            name: 'Replaced',
            deadline: '2026-12-03T00:00:00.000Z'
        });
        assert.equal(replaced.status, 200);
        assert.equal(replaced.body.data.description, '');
        assert.equal(replaced.body.data.completed, false);
        assert.equal(replaced.body.data.assignedUser, '');
        assert.equal(replaced.body.data.assignedUserName, 'unassigned');
        assert.equal(replaced.body.data.dateCreated, pendingAgain.body.data.dateCreated);
        assert.deepEqual((await request('GET', '/users/' + grace._id)).body.data.pendingTasks, []);
    });

    it('rejects bad references in order and does not write', async () => {
        const ada = (await request('POST', '/users', { name: 'Ada', email: 'ada@b.com' })).body.data;
        const task = (await request('POST', '/tasks', {
            name: 'Open',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: ada._id,
            assignedUserName: 'Ada'
        })).body.data;
        const done = (await request('POST', '/tasks', {
            name: 'Closed',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: true
        })).body.data;

        const missingUrl = await request('PUT', '/users/not-an-id', {});
        assert.equal(missingUrl.status, 404);
        assert.equal(missingUrl.body.message, 'User not found');

        const missingTaskUrl = await request('PUT', '/tasks/507f1f77bcf86cd799439011', {
            name: 'x',
            deadline: '2026-12-01T00:00:00.000Z'
        });
        assert.equal(missingTaskUrl.status, 404);

        const formatBeforeMissing = await request('PUT', '/users/' + ada._id, {
            name: 'Ada',
            email: 'ada@b.com',
            pendingTasks: ['bad-id', '507f1f77bcf86cd799439011']
        });
        assert.equal(formatBeforeMissing.status, 400);
        assert.deepEqual((await request('GET', '/users/' + ada._id)).body.data.pendingTasks, [task._id]);

        const missingBeforeCompleted = await request('PUT', '/users/' + ada._id, {
            name: 'Ada',
            email: 'ada@b.com',
            pendingTasks: ['507f1f77bcf86cd799439011', done._id]
        });
        assert.equal(missingBeforeCompleted.status, 404);
        assert.equal((await request('GET', '/users/' + ada._id)).body.data.email, 'ada@b.com');

        const ownEmail = await request('PUT', '/users/' + ada._id, {
            name: 'Ada',
            email: 'ada@b.com',
            pendingTasks: [task._id]
        });
        assert.equal(ownEmail.status, 200);

        const other = await request('POST', '/users', { name: 'Bea', email: 'bea@b.com' });
        const taken = await request('PUT', '/users/' + ada._id, {
            name: 'Ada',
            email: 'bea@b.com',
            pendingTasks: []
        });
        assert.equal(taken.status, 400);
        assert.equal((await request('GET', '/users/' + ada._id)).body.data.email, 'ada@b.com');
        assert.equal(other.status, 201);
    });

    it('applies select only on single resources', async () => {
        const ada = (await request('POST', '/users', { name: 'Ada', email: 'ada@b.com' })).body.data;
        const bea = (await request('POST', '/users', { name: 'Bea', email: 'bea@b.com' })).body.data;
        const task = (await request('POST', '/tasks', {
            name: 'Read',
            description: 'chapter',
            deadline: '2026-12-01T00:00:00.000Z'
        })).body.data;

        const userSelect = await request('GET', '/users/' + ada._id + q({ select: { name: 1, _id: 0 } }));
        assert.equal(userSelect.status, 200);
        assert.deepEqual(userSelect.body.data, { name: 'Ada' });

        const taskSelect = await request('GET', '/tasks/' + task._id + q({ select: { _id: 0, description: 1 } }));
        assert.equal(taskSelect.status, 200);
        assert.deepEqual(taskSelect.body.data, { description: 'chapter' });

        const ignored = await request('GET', '/users/' + ada._id + q({
            where: { email: bea.email },
            sort: { name: -1 },
            limit: '1',
            skip: '5',
            count: 'true'
        }));
        assert.equal(ignored.status, 200);
        assert.equal(ignored.body.data.email, 'ada@b.com');

        const badSelect = await request('GET', '/tasks/' + task._id + q({ select: { name: 1, description: 0 } }));
        assert.equal(badSelect.status, 400);

        const missing = await request('GET', '/users/not-a-real-id?select=' + encodeURIComponent('{"name":1}'));
        assert.equal(missing.status, 404);
    });

    it('filters, sorts, pages, and counts tasks with mongoose query options', async () => {
        const deadlines = ['2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'];
        for (let i = 0; i < 3; i++) {
            const created = await request('POST', '/tasks', {
                name: 'task-' + i,
                deadline: deadlines[i],
                completed: i !== 1
            });
            assert.equal(created.status, 201);
        }

        const completed = await request('GET', '/tasks' + q({ where: { completed: true } }));
        assert.equal(completed.status, 200);
        assert.deepEqual(completed.body.data.map((task) => task.name).sort(), ['task-0', 'task-2']);

        const none = await request('GET', '/tasks' + q({ where: { name: 'missing' } }));
        assert.equal(none.status, 200);
        assert.deepEqual(none.body.data, []);

        const ids = completed.body.data.map((task) => task._id);
        const subset = await request('GET', '/tasks' + q({ where: { _id: { $in: ids } } }));
        assert.equal(subset.status, 200);
        assert.equal(subset.body.data.length, 2);

        const sorted = await request('GET', '/tasks' + q({
            sort: { name: -1 },
            skip: '1',
            limit: '1'
        }));
        assert.equal(sorted.status, 200);
        assert.deepEqual(sorted.body.data.map((task) => task.name), ['task-1']);

        const counted = await request('GET', '/tasks' + q({
            where: { completed: true },
            count: 'true',
            limit: '1',
            skip: '1'
        }));
        assert.equal(counted.status, 200);
        assert.equal(counted.body.data, 2);

        const countedNone = await request('GET', '/tasks' + q({ where: { name: 'missing' }, count: 'true' }));
        assert.equal(countedNone.status, 200);
        assert.equal(countedNone.body.data, 0);

        const badJson = await request('GET', '/tasks?where={');
        assert.equal(badJson.status, 400);
        assertEnvelope(badJson);

        const badSort = await request('GET', '/tasks' + q({ sort: { name: 2 } }));
        assert.equal(badSort.status, 400);

        const badLimit = await request('GET', '/tasks?limit=twenty');
        assert.equal(badLimit.status, 400);

        const cast = await request('GET', '/tasks' + q({ where: { deadline: 'not-a-date' } }));
        assert.equal(cast.status, 400);
        assert.doesNotMatch(JSON.stringify(cast.body), /mongoose|cast to/i);

        const hidden = await request('GET', '/tasks' + q({ select: { _id: 0, name: 1 }, sort: { name: 1 } }));
        assert.deepEqual(hidden.body.data, [{ name: 'task-0' }, { name: 'task-1' }, { name: 'task-2' }]);

        await Task.insertMany(Array.from({ length: 105 }, (_, index) => ({
            name: 'bulk-' + String(index).padStart(3, '0'),
            deadline: new Date('2026-12-01T00:00:00.000Z')
        })));
        const limited = await request('GET', '/tasks');
        assert.equal(limited.body.data.length, 100);
        const explicit = await request('GET', '/tasks?limit=105');
        assert.equal(explicit.body.data.length, 105);

        await User.insertMany(Array.from({ length: 105 }, (_, index) => ({
            name: 'user-' + index,
            email: 'user-' + index + '@b.com'
        })));
        const users = await request('GET', '/users');
        assert.equal(users.status, 200);
        assert.equal(users.body.data.length, 105);

        const sortedUsers = await request('GET', '/users' + q({ sort: { name: 1 }, skip: '1', limit: '1', select: { _id: 0, name: 1 } }));
        assert.equal(sortedUsers.body.data.length, 1);
    });

    it('deletes users and tasks and cleans references', async () => {
        const ada = (await request('POST', '/users', { name: 'Ada', email: 'ada@b.com' })).body.data;
        const pending = (await request('POST', '/tasks', {
            name: 'Pending',
            deadline: '2026-12-01T00:00:00.000Z',
            assignedUser: ada._id,
            assignedUserName: 'Ada'
        })).body.data;
        const done = (await request('POST', '/tasks', {
            name: 'Done',
            deadline: '2026-12-01T00:00:00.000Z',
            completed: true,
            assignedUser: ada._id,
            assignedUserName: 'Ada'
        })).body.data;

        const removedTask = await request('DELETE', '/tasks/' + pending._id);
        assert.equal(removedTask.status, 204);
        assert.equal(removedTask.text, '');
        assert.equal((await request('GET', '/tasks/' + pending._id)).status, 404);
        assert.deepEqual((await request('GET', '/users/' + ada._id)).body.data.pendingTasks, []);

        const missingDelete = await request('DELETE', '/tasks/not-an-id');
        assert.equal(missingDelete.status, 404);
        assertEnvelope(missingDelete);

        const removedUser = await request('DELETE', '/users/' + ada._id);
        assert.equal(removedUser.status, 204);
        assert.equal((await request('GET', '/users/' + ada._id)).status, 404);
        const leftover = (await request('GET', '/tasks/' + done._id)).body.data;
        assert.equal(leftover.assignedUser, '');
        assert.equal(leftover.assignedUserName, 'unassigned');
    });
});
