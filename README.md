# artillery-plugin-prometheus
Plugin for Artillery.IO that records response data into Prometheus.

To use:

1. `npm install -g artillery`
2. `npm install artillery-plugin-prometheus`
3. Add `prometheus` Plugin config to your "`hello.json`" Artillery script

    ```json
    {
      "config": {
        "plugins": {
            "prometheus": {
                "testName": "my_load_test_case",
                "pushGatewayUrl": "http://localhost:9091",
                "environment": "qa",
                "labels": {
                   "performance-test"
                   "artillery.io"
            }
        }
      }
    }
    ```

4. `artillery run hello.json`

This will cause every latency to be published to the given Prometheus instance.

## Plug-In Configuration Options
|**Property**|**Required**|**Default**|**Meaning**|
:----------------|:----:|:---------------:|:--------|
`pushGatewayUrl` |*yes*|*none*| Url of the prometheus push gateway.|
`testName`        |*yes*|*none*  |Name of the test being performed.|
`environment` |*yes*|*none*|The environment where the test is running, used as a label.|

*see notes on using environment variables for these values below.

For more information, see:

* https://github.com/shoreditch-ops/artillery

Enjoy!
