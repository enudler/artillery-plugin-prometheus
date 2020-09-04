'use strict';

let uuid = require('uuid'),
    util = require('util'),
    metric = require('./metrics.js'),
    promClient = require('prom-client'),
    jobUUID = uuid.v4(),
    constants = {
        PLUGIN_NAME: 'prometheus',

        // indexes of artillery's results:
        TIMESTAMP: 0,
        REQUEST_ID: 1,
        LATENCY: 2,
        STATUS_CODE: 3,
        PATH: 4,
        TIMINGS: 5,
		
        // required configuration names
        runnerMeasurements: 'testName',
        CONFIG_TEST_NAME: 'testName',
        CONFIG_CPU_MEASUREMENT_NAME: 'cpu',
        CONFIG_MEMORY_MEASUREMENT_NAME: 'memory',
        CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME: 'avoidedScenarios',
        CONFIG_PENDING_REQUESTS_MEASUREMENT_NAME: 'pendingRequests',
        CONFIG_PUSH_GATEWAY_URL: 'pushGatewayUrl',

        // Defaults
        DEFAULT_REQUEST_PHASES_DURATION_SECONDS: 'request_duration_seconds',
        DEFAULT_CONNECTION_TIMINGS_SECONDS: 'connection_timings_seconds',
        DEFAULT_RUNNER_STATS: 'runnerStats',
        DEFAULT_MEASUREMENT_NAME: 'latency',
        DEFAULT_ERROR_MEASUREMENT_NAME: 'clientErrors',
        DEFAULT_CPU_MEASUREMENT_NAME: 'cpu',
        DEFAULT_MEMORY_MEASUREMENT_NAME: 'memory',
        DEFAULT_AVOIDED_SCENARIOS_MEASUREMENT_NAME: 'avoided_scenarios',
        DEFAULT_PENDING_REQUESTS_MEASUREMENT_NAME: 'pending_requests',
        DEFAULT_BUCKET_SIZE: [0.01, 0.05, 0.010, 0.50, 0.100, 0.200, 0.300, 0.400, 0.500, 1, 2, 5, 10, 30, 60, 120]
    },
    requestPhaseDuration, requestLatencyDuration, counterClientErrors, artillieryRunningGauge,
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
                    }, testReport._pendingRequests);
                    artillieryRunningGauge.set({
                        field: constants.CONFIG_AVOIDED_SCENARIOS_MEASUREMENT_NAME
                    }, testReport._scenariosAvoided);


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

            requiredPrometheusConfigs.forEach(function (configName) {
                    if (!scriptConfig[configName]) {
                        impl.handleError(util.format(messages.pluginParamIsRequired, constants.CONFIG_PUSH_GATEWAY_URL + '.' + configName));
                    }
                }
            );

            return scriptConfig;
        },
        createPrometheusMeasurements: (config) => {
            requestLatencyDuration = promClient.register.getSingleMetric(constants.DEFAULT_CONNECTION_TIMINGS_SECONDS) ||
                new promClient.Histogram({
                    name: constants.DEFAULT_CONNECTION_TIMINGS_SECONDS,
                    help: 'Duration of connecti requests in seconds',
                    labelNames: ['path', 'status_code'],
                    buckets: config.bucketSizes || constants.DEFAULT_BUCKET_SIZE
                });

            requestPhaseDuration = new promClient.Histogram({
                name: constants.DEFAULT_REQUEST_PHASES_DURATION_SECONDS,
                help: 'Duration of phases in the request in seconds',
                labelNames: ['path', 'status_code', 'phase'],
                buckets: config.bucketSizes || constants.DEFAULT_BUCKET_SIZE
            });

            counterClientErrors = promClient.register.getSingleMetric(constants.DEFAULT_ERROR_MEASUREMENT_NAME) ||
                new promClient.Counter({
                    name: constants.DEFAULT_ERROR_MEASUREMENT_NAME,
                    help: 'Counter of client errors like TIMEOUT/EAI_AGAIN',
                    labelNames: ['error']
                });

            artillieryRunningGauge = promClient.register.getSingleMetric(constants.DEFAULT_RUNNER_STATS) ||
                new promClient.Gauge({
                    name: constants.DEFAULT_RUNNER_STATS,
                    help: 'runner stats',
                    labelNames: ['field']
                });
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
                }, sample[constants.LATENCY] / 1000000000);

                if (sample[constants.TIMINGS]) {
                    const timings = sample[constants.TIMINGS];
                    Object.keys(timings).forEach(phase => {
                        requestPhaseDuration.observe({
                            phase,
                            path: sample[constants.PATH],
                            status_code: sample[constants.STATUS_CODE]
                        }, timings[phase] / 1000);
                    })
                }
            }

            impl.pushToGateway(pushGatewayReporter);
            impl.addRunningMeasurements(instance, pushGatewayReporter, testReport);
        },
        reportErrors: (instance, pushGatewayReporter, testReport) => {
            if (testReport._errors) {
                testReport.errors = testReport._errors;
            }

            if (!testReport.errors) {
                return;
            }

            Object.getOwnPropertyNames(testReport.errors).forEach(function (propertyName) {
                counterClientErrors.inc({error: testReport.errors[propertyName]});
            });

            impl.pushToGateway(pushGatewayReporter);
        },
        pushToGateway: (pushGatewayReporter) => {
            pushGatewayReporter.pushAdd({jobName: jobUUID.toString()}, function (err) {
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
            promClient.register.setDefaultLabels(this.config.labels);
            impl.createPrometheusMeasurements(this.config);
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
