'use strict';
var pidusage = require('pidusage');

module.exports.getMetrics = function() {
	return pidusage(process.pid)
		.then(function(stats) {
			stats.memory = stats.memory / 1048576;
			return stats;
		});
};
