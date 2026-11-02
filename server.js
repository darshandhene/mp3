// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Connect to a MongoDB. Tests connect on their own before loading routes.
if (process.env.NODE_ENV !== 'test') {
    mongoose.connect(process.env.MONGODB_URI).catch(function (err) { console.error('MongoDB connection error:', err.message); });
}

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Last-resort handler. Route handlers already hide database internals.
app.use(function (err, req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    if (err instanceof SyntaxError && err.status === 400) {
        return res.status(400).json({ message: 'Invalid JSON body', data: null });
    }
    console.error(err);
    res.status(500).json({ message: 'Internal server error', data: null });
});

// Start the server
if (process.env.NODE_ENV !== 'test') {
    app.listen(port);
    console.log('Server running on port ' + port);
}

module.exports = app;
