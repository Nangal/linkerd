"use strict";

define([
  'jQuery',
  'src/utils',
  'src/bar_chart',
  'template/compiled_templates'
], function($,
  Utils,
  BarChart,
  templates
) {
  var RetriesBarChart = function($container) {
    function displayPercent(percent) {
      return _.isNumber(percent) ? Math.round(percent * 100) + "%" : " - ";
    }

    function getColor(percent) {
      if (percent < 0.5) return "red";
      else if (percent < 0.75) return "orange";
      else return "green";
    }

    function getPercent(data, configuredBudget) {
      var retryPercent = !data["requests"] ? null : (data["retries"] || 0) / data["requests"];
      var budgetRemaining = Math.max(configuredBudget - (retryPercent || 0), 0);
      var healthBarPercent = Math.min(budgetRemaining / configuredBudget, 1);

      return {
        percent: healthBarPercent,
        label: {
          description: "Retry budget available",
          value: displayPercent(budgetRemaining) + " / " + displayPercent(configuredBudget)
        },
        warningLabel: retryPercent < configuredBudget ? null : "budget exhausted"
      }
    }

    var retriesBarChart = new BarChart($container, getColor);

    return {
      update: function(data, retryBudget) {
        retriesBarChart.update(getPercent(data, retryBudget));
      }
    }
  }

  var RouterSummary = (function() {
    var DEFAULT_BUDGET = 0.2 // default 20%
    var template = templates.router_summary;

    function getMetrics(routerName) {
      var serverAccessor = ["rt", routerName, "srv"];
      var clientAccessor = ["rt", routerName, "dst", "id"];
      var pathAccessor = ["rt", routerName, "dst", "path", "svc"];

      return {
        load: {
          metricAccessor: ["load"],
          accessor: serverAccessor,
          isGauge: true,
        },
        requests: {
          metricAccessor: ["requests"],
          accessor: serverAccessor,
        },
        success: {
          metricAccessor: ["success"],
          accessor: serverAccessor,
        },
        failures: {
          metricAccessor: ["failures"],
          accessor: serverAccessor,
        },
        requeues: {
          accessor: clientAccessor,
          metricAccessor: ["retries", "requeues"],
        },
        pathRetries: {
          accessor: pathAccessor,
          metricAccessor: ["retries", "total"],
          isPath: true
        },
      };
    }

    function processResponses(data, routerName, metrics) {
      function process(metric) {
        var datum = _(data).get(metrics[metric].accessor);
        var m = metrics[metric];

        if(m.isPath) {
          return _.get(datum, m.metricAccessor.concat(m.isGauge ? "value" : "delta")) || 0;
        } else {
          return _.reduce(datum, function(mem, entityData) {
            mem += _.get(entityData, m.metricAccessor.concat(m.isGauge ? "value" : "delta")) || 0;
            return mem;
          }, 0);
        }
      }

      var result = {
        router: routerName,
        load: process("load", true),
        requests: process("requests"),
        success: process("success"),
        failures: process("failures"),
        retries: process("pathRetries") + process("requeues")
      }
      var rates = getSuccessAndFailureRate(result);
      return  $.extend(result, rates);
    }

    function getSuccessAndFailureRate(result) {
      if (_.isUndefined(result.failures)) result.failures = null;
      var successRate = new Utils.SuccessRate(result.success || 0, result.failures || 0);
      return {
        successRate: successRate.prettyRate(),
        failureRate: getFailureRate(result)
      };
    }

    function getFailureRate(datum) {
      // TODO: #198 remove or refactor with SuccessRate in utils
      // there's some discussion as to whether we should include both success
      // and failure rate.  this is a very sketchy implementation of this until
      // we decide for sure
      if (datum.requests === 0) {
        return "N/A";
      } else {
        return (100*datum.failures/datum.requests).toFixed(2) + "%";
      }
    }

    function renderRouterSummary(routerData, routerName, $summaryEl) {
      $summaryEl.html(template(routerData));
    }

    function getRetryBudget(routerName, config) {
      if (!config) return DEFAULT_BUDGET;

      var routerObj = _.find(config.routers, function(router) {
        return router.label === routerName;
      });

      return _.get(routerObj, 'client.retries.budget.percentCanRetry', DEFAULT_BUDGET);
    }

    function getMetricAccessor(metric, entity) {
      return _.concat(metric.accessor, entity || [], metric.metricAccessor, metric.isGauge ? "gauge" : "counter");
    }

    return function(metricsCollector, $summaryEl, $barChartEl, routerName, routerConfig) {
      var $retriesBarChart = $barChartEl.find(".retries-bar-chart");

      var retriesBarChart = new RetriesBarChart($retriesBarChart);
      var retryBudget = getRetryBudget(routerName, routerConfig);

      var routerMetrics = getMetrics(routerName);

      renderRouterSummary({ router: routerName }, routerName, $summaryEl);

      metricsCollector.registerListener(metricsHandler, getDesiredMetrics);

      function metricsHandler(data) {
        var summaryData = processResponses(data.treeSpecific, routerName, routerMetrics);

        retriesBarChart.update(summaryData, retryBudget);
        renderRouterSummary(summaryData, routerName, $summaryEl);
      }

      function getDesiredMetrics(treeMetrics) {
        if (treeMetrics) {
          var metricsList =  _.map(routerMetrics, function(metric) {
            if(metric.isPath) {
              return [getMetricAccessor(metric)];
            } else {
              var entities = _.get(treeMetrics, metric.accessor); // servers or clients
              return _.map(entities, function(entityData, entity) {
                return getMetricAccessor(metric, entity);
              });
            }
          });
          return _.flatMap(metricsList);
        } else {
          return [];
        }
      }

      return {};
    };
  })();

  return RouterSummary;
});
