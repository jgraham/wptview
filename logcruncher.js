importScripts("workerApi.js");

onmessage = messageAdapter(new LogReader());

function LogReader() {}

LogReader.prototype.read = function(file) {
  return readFile(file)
    .then((logData) => {return logCruncher(logData, testsFilter)});
}

LogReader.prototype.readURL = function(url) {
  return readURL(url)
    .then((logData) => {return logCruncher(logData, testsFilter)});
}

function logCruncher(rawtext, filter) {
  return new Promise(function (resolve, reject) {
    var JSONArray = [];
    var lines = rawtext.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (lines[i] === "") {
        continue;
      }
      var json = JSON.parse(lines[i]);
      if (filter(json)) {
        JSONArray.push(json);
      }
    }
    resolve(JSONArray);
  });
}

function testsFilter(parsedLine) {
  var pattr = /^test_/;
  var pattr2 = /^(?:error)|(?:critical)/i;
  return (pattr.test(parsedLine.action) || (parsedLine.action === "log" && pattr2.test(parsedLine.level)));
}

function readFile(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReaderSync();
    resolve(reader.readAsText(file, "UTF-8"));
  });
}

function readURL(url) {
  return new Promise(function(resolve, reject) {
    var xhttp = new XMLHttpRequest();
    xhttp.onreadystatechange = function() {
      if (xhttp.readyState == 4) {
        if (xhttp.status == 200) {
          resolve(xhttp.responseText);
        } else {
          reject("HTTP request failed!");
        }
      }
    };
    xhttp.open('GET', url, false);
    xhttp.send();
  });
}
