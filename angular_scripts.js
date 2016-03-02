var app = angular.module('wptview', ['angularSpinner']);

app.directive('customOnChange', function() {
  return {
    restrict: 'A',
    link: function (scope, element, attrs) {
      var onChangeHandler = scope.$eval(attrs.customOnChange);
      element.bind('change', onChangeHandler);
    }
  };
});

app.filter('arrFilter', function() {
  return function(collection, currentRun) {
    return collection.filter((item) => currentRun != item.name && currentRun != "ALL" && item.enabled);
  }
});

app.filter('enabledFilter', function() {
  return function(collection) {
    return collection.filter((item) => item.enabled);
  }
});

function WorkerService(workerScript) {
  this.msg_id = 0;
  this.resolvers = {};

  this.worker = new Worker(workerScript);
  this.worker.onmessage = function(event) {
    var msg_id = event.data[0];
    var data = event.data[1];
    if (!this.resolvers.hasOwnProperty(msg_id)) {
      throw Error("Unexpected message " + msg_id);
    }
    resolve = this.resolvers[msg_id];
    delete this.resolvers[msg_id];
    resolve(data);
  }.bind(this);
}

WorkerService.prototype.run = function(command, data) {
  var data = data || [];
  var msg = [this.msg_id++, command, data];
  this.worker.postMessage(msg);
  return new Promise((resolve) => {
    this.resolvers[msg[0]] = resolve;
  });
}

app.factory('ResultsModel',function() {
  var ResultsModel = function() {
    this.service = new WorkerService("LovefieldService.js");
    this.logReader = new WorkerService("logcruncher.js");
  }

  ResultsModel.prototype.addResultsFromLogs = function (source, runName, fetchFunc) {
    var lovefield = this.service;
    var resultData = null;
    var testData = null;
    var testRunData = null;
    var duplicates = null;
    var runType = null;
    if (fetchFunc === "readURL") {
      runType = {
        "type": "url",
        "url": source
      };
    } else if (fetchFunc === "read") {
      runType = {
        "type": "file",
        "url": null
      };
    }
    return this.logReader.run(fetchFunc, [source])
      .then((data) => {resultData = data})
      // Filling the test_runs table
      .then(() => {return lovefield.run("selectParticularRun", [runName])})
      .then((testRuns) => {return lovefield.run("insertTestRuns", [runType, runName, testRuns])})
      // Selecting current tests table, adding extra entries only
      .then((testRuns) => {testRunData = testRuns;
                           return lovefield.run("selectAllParentTests")})
      .then((parentTests) => {return lovefield.run("insertTests", [resultData, parentTests])})
      .then((insertData) => {
        duplicates = insertData[1];
        return lovefield.run("selectAllParentTests")
      })
      // populating results table with parent test results
      .then((tests) => {testData = tests;
                        return lovefield.run("insertTestResults",
                                             [resultData, testData, testRunData])})
      // add subtests to tests table
      .then(() => {return lovefield.run("selectAllSubtests")})
      .then((subtests) => {return lovefield.run("insertSubtests",
                                                [resultData, testData, subtests])})
      .then((subtestData) => {duplicates = duplicates.concat(subtestData[1]);
                              return lovefield.run("selectAllSubtests")})
      // adding subtest results
      .then((subtests) => {return lovefield.run("insertSubtestResults",
                                                [resultData, subtests, testRunData])})
      .then(() => duplicates);
  }

  /*
    Load the results of a specified number of tests, ordered by test id, either taking all
    results above a lower limit test id, all results below an upper limit id, or all results
    starting from the first test.
    Results may be filtered by various filters.
    @param {Object[]} filter - Array of filter definitions for the allowed test results.
    @param {} pathFilter - Array if filter definitions for the allowed test names.
    @param {(number|null)} minTestId - Exclusive lower bound on the test ID to load, or null if
                                     there is no lower limit.
    @param {(number|null)} maxTestId - Exclusive upper bound on the test ID to load, or null if
                                     there is no upper limit.
    @param {(number)} limit - Number of tests to load.
   */
  ResultsModel.prototype.switchRuns = function(run_ids, enabled) {
    return this.service.run("switchRuns", [run_ids, enabled]);
  };
  ResultsModel.prototype.getResults = function(filter, runs, minTestId, maxTestId, limit) {
    return this.service.run("selectFilteredResults",
                            [filter, runs, minTestId, maxTestId, limit]);
  }

  ResultsModel.prototype.getComment = function(result_id) {
    return this.service.run("selectComment", [result_id]);
  }

  ResultsModel.prototype.saveComment = function(result_id, comment, update) {
    if(update){
      return this.service.run("updateComment", [result_id, comment]);
    } else {
      return this.service.run("insertComment", [result_id, comment]);
    }
  }

  ResultsModel.prototype.deleteComment = function(result_id) {
    return this.service.run("deleteComment", [result_id]);
  }

  ResultsModel.prototype.removeComments = function(run_id) {
    return this.service.run("deleteComments", [run_id]);
  }

  ResultsModel.prototype.removeResults = function(run_id) {
    return this.service.run("deleteEntries", [run_id]);
  }

  ResultsModel.prototype.getRuns = function() {
    return this.service.run("getRuns");
  }

  ResultsModel.prototype.getRunURLs = function() {
    return this.service.run("getRunURLs");
  }

  return ResultsModel;
});

app.controller('wptviewController', function($scope, $location, $interval, ResultsModel) {
  $scope.results = null;
  $scope.warnings = [];
  $scope.showImport = false;
  $scope.busy = true;
  $scope.runs = null;
  $scope.upload = {};
  $scope.displayError = {
      test: "",
      subtest: "",
      expected: "",
      status: "",
      error: "",
      visible: false
  }
  $scope.resultsView = {
      limit: 50,
      firstPage: true,
      lastPage: false,
      minTestId: null,
      maxTestId: null,
      firstTestId: null
  }
  $scope.filter = {
    "statusFilter": [],
    "pathFilter": [],
    "testTypeFilter": {
      type:"both"
    }
  }
  var runIndex = {};
  var resultsModel = new ResultsModel();

  function updateRuns() {
    var runs;
    return resultsModel.getRuns()
      .then((runsData) => runs = runsData)
      .then(() => {
        $scope.runs = runs;
        $scope.runs.forEach((run, i) => {
          runIndex[run.run_id] = i;
        });
      });
  }

  function addRun(source, name, type) {
    return resultsModel.addResultsFromLogs(source, name, type)
    .then((duplicates) => {return updateWarnings(duplicates)});
  }

  function getRunURLs() {
    return resultsModel.getRunURLs();
  }

  function checkQuery(urls) {
    urls = urls.map((result) => result.url);
    var run_strings = [];
    if ($location.search() && $location.search().hasOwnProperty("urls")) {
      run_strings = $location.search().urls.split(";");
    }
    var runs = [];
    var run_names = {};
    $scope.runs.forEach((run) => {
      run_names[run.name] = 1;
    });
    run_strings.forEach((run) => {
      var parameters = run.split(",");
      if (urls.indexOf(parameters[0]) == -1) {
        if (run_names.hasOwnProperty(parameters[1])) {
          var original_name = parameters[1];
          while (run_names.hasOwnProperty(parameters[1])) {
            parameters[1] = original_name + " (" + run_names[original_name] + ")";
            run_names[original_name] += 1;
          }
        } else {
          run_names[parameters[1]] = 1;
        }
        runs.push({
          "url": parameters[0],
          "name": parameters[1]
        });
      }
    });
    var disabledRuns = [];
    if (runs.length) {
      disabledRuns = $scope.runs.map((run) => run.run_id);
    }
    var add_runs = runs.map((run) => addRun(run.url, run.name, "readURL"));
    return resultsModel.switchRuns(disabledRuns, false)
      .then(() => {return Promise.all(add_runs)});
  }

  // first updateRuns() helps initialize the database
  updateRuns()
  .then(() => getRunURLs())
  .then((urls) => checkQuery(urls))
  .then(() => updateRuns())
  .then(() => {
    $scope.busy = false;
    $scope.$apply();
  });


  function updateWarnings(duplicates) {
    $scope.$apply(function() {
      $scope.warnings = duplicates;
    })
  }

  $scope.range = function(min, max, step) {
      step = step || 1;
      var input = [];
      for (var i = min; i < max; i += step) {
          input.push(i);
      }
      return input;
  };

  $scope.fetchLog = function () {
     if ($scope.upload.logSrc == 'file') {
         $scope.uploadFile();
     } else if ($scope.upload.logSrc == 'url') {
         $scope.fetchFromUrl();
     }
  }

  $scope.uploadFile = function () {
    $scope.busy = true;
    var evt = $scope.fileEvent;
    var file = evt.target.files[0];
    addRun(file, $scope.upload.runName, "read")
    .then(updateRuns)
    .then(() => {
      $scope.isFileEmpty = true;
      $scope.upload.runName = "";
      $scope.busy = false;
      $scope.$apply();
    });
  }

  $scope.fetchFromUrl = function () {
    $scope.busy = true;
    addRun($scope.upload.logUrl, $scope.upload.runName, "readURL")
    .then(updateRuns)
    .then(() => {
      $scope.upload.runName = "";
      $scope.busy = false;
      $scope.$apply();
    });
  }

  $scope.switchRun = function(run) {
    $scope.busy = true;
    resultsModel.switchRuns([run.run_id], run.enabled)
    .then(() => {
      $scope.busy = false;
      $scope.results = null;
      $scope.$apply();
    });
  }

  $scope.clearTable = function(run_id) {
    $scope.busy = true;
    resultsModel.removeComments(run_id)
      .then(() => {
        return resultsModel.removeResults(run_id)
          .then(() => {
            $scope.results = null;
            $scope.warnings = []})
        .then(updateRuns)
        .then(() => {
          $scope.busy = false;
          $scope.$apply();
        });
      });
  }

  $scope.export = function() {
    $scope.busy = true;
    resultsModel.getResults($scope.filter, $scope.runs)
    .then((results) => {
      var finaljson = {};
      finaljson.runs = $scope.runs.map((run) => run.name);
      finaljson.results = {};
      var organizedResults = organizeResults(results);
      organizedResults.forEach((result) => {
        if (!finaljson.results.hasOwnProperty(result.test)) {
          finaljson.results[result.test] = [];
        }
        var run_results = result.runs.map((run) => [run.expected, run.status, run.message]);
        finaljson.results[result.test].push([result.subtest].concat(run_results));
      });
      saveData(finaljson, "result.json");
      $scope.busy = false;
      $scope.$apply();
    });
  }

  // http://jsfiddle.net/koldev/cw7w5/
  function saveData(data, fileName) {
    var a = document.createElement("a");
    document.body.appendChild(a);
    a.style = "display: none";
    var json = JSON.stringify(data),
        blob = new Blob([json], {type: "octet/stream"}),
        url = window.URL.createObjectURL(blob);
    a.href = url;
    a.download = fileName;
    a.click();
    window.URL.revokeObjectURL(url);
  }

  $scope.fillTable = function(page) {
    var minTestId = null;
    var maxTestId = null;

    $scope.busy = true;

    if (page === "next") {
      var minTestId = $scope.resultsView.maxTestId;
    } else if (page === "prev") {
      var maxTestId = $scope.resultsView.minTestId;
    }

    resultsModel.getResults($scope.filter, $scope.runs, minTestId, maxTestId, $scope.resultsView.limit)
      .then((results) => {
        if (results.length) {
          if (!page) {
            $scope.resultsView.firstTestId = results[0].test_id;
          }
          $scope.resultsView.lastPage = results.length < $scope.resultsView.limit;
          $scope.resultsView.firstPage = results[0].test_id === $scope.resultsView.firstTestId;
          $scope.resultsView.minTestId = results[0].test_id;
          $scope.resultsView.maxTestId = results[results.length - 1].test_id;
        } else {
          // We want to disable NEXT when we are on the last page
          $scope.resultsView.lastPage = true;
        }
        var finalResults = organizeResults(results);
        $scope.results = finalResults;
        $scope.busy = false;
        $scope.$apply();
      });
  }

  $scope.newFile = function(evt) {
    $scope.isFileEmpty = false;
    $scope.fileEvent = evt;
    $scope.$apply();
  }

  $scope.addConstraint = function() {
    $scope.filter.statusFilter.push({
      run : $scope.runs[0].name,
      equality : "is",
      status : ["PASS"]
    });
  }

  $scope.deleteConstraint = function() {
    $scope.filter.statusFilter.pop();
  }

  $scope.addOrConstraint = function(index) {
    $scope.filter.statusFilter[index].status.push("PASS");
  }

  $scope.deleteOrConstraint = function(index) {
    $scope.filter.statusFilter[index].status.pop();
  }

  $scope.addPath = function() {
    $scope.filter.pathFilter.push({
      choice: "include:start",
      path: ""
    });
  }

  $scope.deletePath = function() {
    $scope.filter.pathFilter.pop();
  }

  $scope.warning_message = function() {
    return $scope.warnings.length + " warnings found.";
  }

  $scope.showError = function(run, result) {
    saveComment();

    $scope.displayError.test = result.test;
    $scope.displayError.subtest = result.subtest;
    $scope.displayError.expected = run.expected;
    $scope.displayError.status = run.status;
    $scope.displayError.error = run.message;
    $scope.displayError.result_id = result.result_id;

    $scope.busy = true;

    resultsModel.getComment(result.result_id)
      .then((comment) => {
        if(comment.length) {
          $scope.displayError.comment = comment[0].comment;
        } else {
          $scope.displayError.comment = "";
        }
        $scope.displayError.commentBox = $scope.displayError.comment;
        $scope.displayError.visible = true;
        $scope.displayError.commentSaveFunc = $interval(saveComment, 5000);

        $scope.busy = false;
      });
  }

  $scope.closeError = function(){
    $scope.displayError.visible = false;
    saveComment();
    if($scope.displayError.commentSaveFunc){
      $interval.cancel($scope.displayError.commentSaveFunc);
      $scope.displayError.commentSaveFunc = undefined;
    }
  }

  function saveComment(){
    comment = $scope.displayError.comment;
    comment_new = $scope.displayError.commentBox;
    result_id = $scope.displayError.result_id;
    if($scope.displayError.visible && comment != comment_new){
      console.log("save comment");
      if(comment_new == ""){
        resultsModel.deleteComment(result_id);
      } else {
        resultsModel.saveComment(result_id, comment_new, comment != "");
      }
      $scope.displayError.comment = comment_new;
    }
  }

  function organizeResults(results) {
    var testMap = {};
    results.forEach(function(result) {
      if (result.title === undefined) {
        result.title = "";
      }
      if (!testMap.hasOwnProperty(result.test)) {
        testMap[result.test] = {};
      }
      if (!testMap[result.test].hasOwnProperty(result.title)) {
        testMap[result.test][result.title] = {runs: [], id: result.result_id};
        for (var i = 0; i < $scope.runs.length; i++) {
          testMap[result.test][result.title].runs.push({
            'run_id': $scope.runs[i].run_id,
            'run_name': $scope.runs[i].run_name,
            'enabled': $scope.runs[i].enabled,
            'status': "",
            'expected': "",
            'message': ""
          });
        }
      }
      var x = testMap[result.test][result.title].runs[runIndex[result.run_id]];
      x.status = result.status;
      x.expected = result.expected;
      x.message = result.message;
    });
    var finalResults = [];
    for (var test in testMap) {
      for (var subtest in testMap[test]) {
        finalResults.push({
          'test': test,
          'subtest': subtest,
          'runs': testMap[test][subtest].runs,
          'result_id': testMap[test][subtest].id
        });
      }
    }
    return finalResults;
  }
});
