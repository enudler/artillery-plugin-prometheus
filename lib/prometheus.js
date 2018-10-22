'use strict';

let uuid = require('uuid'),
	util = require('util'),
	metric = require('./metrics.js'),
	promClient = require('prom-client'),
	constants = {
		PLUGIN_NAME: 'prometheus',

		// indexes of artillery's results:
		TIMESTAMP: 0,
		REQUEST_ID: 1,
		LATENCY: 2,
		STATUS_CODE: 3,
		PATH: 4,

		// required configuration names
		runnerMeasurements: 'testName',
		CONFIG_TEST_NAME: 'testName',
		CONFIG_CPU_MEASUREMENT_NAME: 'cpu',
		CONFIG_MEMORY_MEASUREMENT_NAME: 'memory',
		CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME: 'avoidedScenarios',
		CONFIG_PENDING_REQUESTS_MEASUREMENT_NAME: 'pendingRequests',
		CONFIG_TEST_RUN_ID: 'testRunId',
		CONFIG_EXCLUDE_TEST_RUN_ID: 'excludeTestRunId',
		CONFIG_ENVIRONMENT: 'environment',
		CONFIG_PUSH_GATEWAY_URL: 'pushGatewayUrl',
		CONFIG_STATIC_TAGS: 'tags',
		CONFIG_SHOW_MATCHES: 'show',
		CONFIG_PROMETHEUS: 'prometheus',


		// Defaults
		DEFAULT_REQUEST_DURATION_MS: 'request_duration_ms',
		DEFAULT_RUNNER_STATS: 'runnerStats',
		DEFAULT_MEASUREMENT_NAME: 'latency',
		DEFAULT_ERROR_MEASUREMENT_NAME: 'clientErrors',
		DEFAULT_CPU_MEASUREMENT_NAME: 'cpu',
		DEFAULT_MEMORY_MEASUREMENT_NAME: 'memory',
		DEFAULT_AVOIDED_SCENARIOS_MEASUREMENT_NAME: 'avoided_scenarios',
		DEFAULT_PENDING_REQUESTS_MEASUREMENT_NAME: 'pending_requests'
	},

	requestLatencyDuration = promClient.register.getSingleMetric(constants.DEFAULT_REQUEST_DURATION_MS) ||
        new promClient.Histogram({
        	name: constants.DEFAULT_REQUEST_DURATION_MS,
        	help: 'Duration of outgoing requests in ms',
        	labelNames: ['path', 'status_code'],
        	buckets: [1, 5, 10, 50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000]
        }),

	counterClientErrors = promClient.register.getSingleMetric(constants.DEFAULT_ERROR_MEASUREMENT_NAME) ||
        new promClient.Counter({
        	name: constants.DEFAULT_ERROR_MEASUREMENT_NAME,
        	help: 'Counter of client errors like TIMEOUT/EAI_AGAIN',
        	labelNames: ['error']
        }),

	artillieryRunningGauge = promClient.register.getSingleMetric(constants.DEFAULT_RUNNER_STATS) ||
        new promClient.Gauge({
        	name: constants.DEFAULT_RUNNER_STATS,
        	help: 'runner stats',
        	labelNames: ['field']
        }),

	messages = {
		pluginsConfigNotFound: 'No "plugins" configuration found.',
		pluginConfigIsRequired: 'The configuration for %s is required.',
		pluginParamIsRequired: 'The configuration parameter %s is required.',
		pluginParamOrEnvIsRequired: 'The configuration parameter %s or environment variable %s is required.',
		metricsReportedToPrometheus: '%s metrics reported to Prometheus.'
	},
	impl = {
		handleError: (message) => {
			console.error(message);
			throw new Error(message);
		},
		addRunningMeasurements: (instance, pushGatewayReporter, testReport) => {
			return metric.getMetrics()
				.then(function (stats) {
					artillieryRunningGauge.set({
						field: constants.CONFIG_CPU_MEASUREMENT_NAME
					}, stats.cpu);
					artillieryRunningGauge.set({
						field: constants.CONFIG_MEMORY_MEASUREMENT_NAME
					}, stats.memory);
					artillieryRunningGauge.set({
						field: constants.CONFIG_PENDING_REQUESTS_MEASUREMENT_NAME
					}, testReport._scenariosAvoided);
					artillieryRunningGauge.set({
						field: constants.CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME
					}, testReport._pendingRequests);


					impl.pushToGateway(pushGatewayReporter);
				});
		},
		validateConfig: (scriptConfig) => {
		// These are the minimum required config values
			let requiredPrometheusConfigs = [
				constants.CONFIG_PUSH_GATEWAY_URL
			];

			// There must be a configuration object.
			if (!scriptConfig) {
				impl.handleError(util.format(messages.pluginConfigIsRequired, constants.PLUGIN_NAME));
			}

			// Create a set of static tags if none already
			if (!scriptConfig[constants.CONFIG_STATIC_TAGS]) {
				scriptConfig[constants.CONFIG_STATIC_TAGS] = {};
			}

			// It must provide a test name; alternate version accepted.
			if (!scriptConfig[constants.CONFIG_TEST_NAME]) {
				impl.handleError(util.format(messages.pluginParamIsRequired, constants.CONFIG_TEST_NAME));
			}

			// Add the test name to the set of tags to be written
			scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_NAME] = scriptConfig[constants.CONFIG_TEST_NAME];

			if (!scriptConfig[constants.CONFIG_CPU_MEASUREMENT_NAME]) {
				scriptConfig[constants.CONFIG_CPU_MEASUREMENT_NAME] = constants.DEFAULT_CPU_MEASUREMENT_NAME;
			}

			if (!scriptConfig[constants.CONFIG_MEMORY_MEASUREMENT_NAME]) {
				scriptConfig[constants.CONFIG_MEMORY_MEASUREMENT_NAME] = constants.DEFAULT_MEMORY_MEASUREMENT_NAME;
			}

			if (!scriptConfig[constants.CONFIG_PENDING_REQUESTS_MEASUREMENT_NAME]) {
				scriptConfig[constants.CONFIG_PENDING_REQUESTS_MEASUREMENT_NAME] = constants.DEFAULT_PENDING_REQUESTS_MEASUREMENT_NAME;
			}

			if (!scriptConfig[constants.CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME]) {
				scriptConfig[constants.CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME] = constants.DEFAULT_AVOIDED_SCENARIOS_MEASUREMENT_NAME;
			}

			// If no testRunId is provided in the static tags, and excludeTestRunId is not set then generate one.
			if (!scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_RUN_ID] &&
                !scriptConfig[constants.CONFIG_EXCLUDE_TEST_RUN_ID]) {
				scriptConfig[constants.CONFIG_STATIC_TAGS][constants.CONFIG_TEST_RUN_ID] = uuid.v4();
			}

			requiredPrometheusConfigs.forEach(function (configName) {
				if (!scriptConfig[configName]) {
					impl.handleError(util.format(messages.pluginParamIsRequired, constants.CONFIG_PUSH_GATEWAY_URL + '.' + configName));
				}
			}
			);

			return scriptConfig;
		},
		createPushGatewayReporter: (config) => {
			let pushGatewayClient = new promClient.Pushgateway(config.pushGatewayUrl);
			return pushGatewayClient;
		},
		reportResults: (instance, pushGatewayReporter, testReport) => {
			let samples = 0,
				sample;

			// Work around change in testReport schema in artillery-core (Issue #3)
			if (testReport._entries) {
				testReport.latencies = testReport._entries;
			}

			while (samples < testReport.latencies.length) {
				sample = testReport.latencies[samples++];

				requestLatencyDuration.observe({
					path: sample[constants.PATH],
					status_code: sample[constants.STATUS_CODE]
				}, sample[constants.LATENCY] / 1000000);

			}

			impl.pushToGateway(pushGatewayReporter);
			impl.addRunningMeasurements(instance, pushGatewayReporter, testReport);
		},
		reportErrors: (instance, pushGatewayReporter, testReport) => {
			if (testReport._errors) {
				testReport.errors = testReport._errors;
			}

			// If there are no errors or error measurement name not defined (or empty), then exit.
			if (!testReport.errors) {
				return;
			}

			Object.getOwnPropertyNames(testReport.errors).forEach(function (propertyName) {
				counterClientErrors.inc({error: testReport.errors[propertyName]});
			});

			impl.pushToGateway(pushGatewayReporter);
		},
		pushToGateway: (pushGatewayReporter) => {
			pushGatewayReporter.pushAdd({jobName: 'artillery'}, function (err) {
				if (err) {
					console.log('Error pushing metrics to push gateway', err);
				}
			});
		}
	},
	api = {
		init: function (scriptConfig, eventEmitter) {
			let pushGatewayReporter,
				that;

			that = this;
			if (!scriptConfig || !scriptConfig.plugins) {
				impl.handleError(constants.pluginsConfigNotFound);
			}

			this.config = impl.validateConfig(scriptConfig.plugins[constants.PLUGIN_NAME]);

			const defaultLabels = {
				testName: scriptConfig.plugins[constants.CONFIG_PROMETHEUS][constants.CONFIG_TEST_NAME],
				cluster: scriptConfig.plugins[constants.CONFIG_PROMETHEUS][constants.CONFIG_ENVIRONMENT],
				testRunId: scriptConfig.plugins[constants.CONFIG_PROMETHEUS][constants.CONFIG_TEST_RUN_ID]
			};
			promClient.register.setDefaultLabels(defaultLabels);

			pushGatewayReporter = impl.createPushGatewayReporter(this.config);
			eventEmitter.on('stats', function (report) {
				impl.reportResults(that, pushGatewayReporter, report);
				impl.reportErrors(that, pushGatewayReporter, report);
			});
		}
	};

module.exports = api.init;

module.exports.constants = constants;
module.exports.messages = messages;
module.exports.impl = impl;
module.exports.api = api;
