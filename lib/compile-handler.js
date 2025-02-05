// Copyright (c) 2012-2017, Matt Godbolt
// All rights reserved.
// 
// Redistribution and use in source and binary forms, with or without 
// modification, are permitted provided that the following conditions are met:
// 
//     * Redistributions of source code must retain the above copyright notice, 
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright 
//       notice, this list of conditions and the following disclaimer in the 
//       documentation and/or other materials provided with the distribution.
// 
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" 
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE 
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE 
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE 
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR 
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF 
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS 
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN 
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) 
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE 
// POSSIBILITY OF SUCH DAMAGE.

var child_process = require('child_process'),
    temp = require("temp");
//var fs = require("fs-extra");
var fs = require("fs");
var path = require("path"),
    httpProxy = require('http-proxy'),
    Promise = require('promise'), // jshint ignore:line
    quote = require('shell-quote'),
    _ = require('underscore-node'),
    logger = require('./logger').logger,
    utils = require('./utils'),
    CompilationEnvironment = require('./compilation-env').CompilationEnvironment;

temp.track();

var oneTimeInit = false;

function initialise(gccProps, compilerEnv) {
    if (oneTimeInit) return;
    oneTimeInit = true;
    var tempDirCleanupSecs = gccProps("tempDirCleanupSecs", 600);
    logger.info("Cleaning temp dirs every " + tempDirCleanupSecs + " secs");
    setInterval(function () {
        if (compilerEnv.isBusy()) {
            logger.warn("Skipping temporary file clean up as compiler environment is busy");
            return;
        }
        temp.cleanup(function (err, stats) {
            if (err) logger.error("Error cleaning directories: ", err);
            if (stats) logger.debug("Directory cleanup stats:", stats);
        });
    }, tempDirCleanupSecs * 1000);
}

function CompileHandler(gccProps, compilerProps) {
    this.compilersById = {};
    this.compilerEnv = new CompilationEnvironment(gccProps, compilerProps);
    initialise(gccProps, this.compilerEnv);
    this.factories = {};
    this.stat = Promise.denodeify(fs.stat);

    this.create = function (compiler) {
        var type = compiler.compilerType || "default";
        if (this.factories[type] === undefined) {
            var compilerPath = './compilers/' + type;
            logger.info("Loading compiler from", compilerPath);
            this.factories[type] = require(compilerPath);
        }
        if (path.isAbsolute(compiler.exe)) {
            // Try stat'ing the compiler to cache its mtime and only re-run it if it
            // has changed since the last time.
            return this.stat(compiler.exe)
                .then(_.bind(function (res) {
                    var cached = this.compilersById[compiler.id];
                    if (cached && cached.mtime.getTime() === res.mtime.getTime()) {
                        logger.debug(compiler.id + " is unchanged");
                        return cached;
                    }
                    return this.factories[type](compiler, this.compilerEnv).then(function (compiler) {
                        compiler.mtime = res.mtime;
                        return compiler;
                    });
                }, this))
                .catch(function (err) {
                    logger.warn("Unable to stat compiler binary", err);
                    return null;
                });
        } else {
            return this.factories[type](compiler, this.compilerEnv);
        }
    };

    this.setCompilers = function (compilers) {
        return Promise.all(_.map(compilers, this.create, this))
            .then(function (compilers) {
                return _.filter(compilers, _.identity);
            })
            .then(_.bind(function (compilers) {
                _.each(compilers, function (compiler) {
                    this.compilersById[compiler.compiler.id] = compiler;
                }, this);
                return _.map(compilers, function (compiler) {
                    return compiler.getInfo();
                });
            }, this)).catch(function (err) {
                logger.error(err);
            });
    };
    var proxy = httpProxy.createProxyServer({});
    var textBanner = compilerProps('textBanner');

    this.handler = _.bind(function compile(req, res, next) {
        var source, options, filters, compiler;
        if (req.is('json')) {
            // JSON-style request
            compiler = this.compilersById[req.compiler || req.body.compiler];
            if (!compiler) return next();
            var requestOptions = req.body.options;
            source = req.body.source;
            options = requestOptions.userArguments;
            backendOptions = requestOptions.compilerOptions;
            filters = requestOptions.filters || compiler.getDefaultFilters();
        } else {
            // API-style
            compiler = this.compilersById[req.compiler];
            if (!compiler) return next();
            source = req.body;
            options = req.query.options;
            // By default we get the default filters.
            filters = compiler.getDefaultFilters();
            // If specified exactly, we'll take that with ?filters=a,b,c
            if (req.query.filters) {
                filters = _.object(_.map(req.query.filters.split(","), function (filter) {
                    return [filter, true];
                }));
            }
            // Add a filter. ?addFilters=binary
            _.each((req.query.addFilters || "").split(","), function (filter) {
                filters[filter] = true;
            });
            // Remove a filter. ?removeFilter=intel
            _.each((req.query.removeFilters || "").split(","), function (filter) {
                delete filters[filter];
            });
        }
        var remote = compiler.getRemote();
        if (remote) {
            req.url = req.originalUrl;  // Undo any routing that was done to get here (i.e. /api/* path has been removed)
            proxy.web(req, res, {target: remote}, function (e) {
                logger.error("Proxy error: ", e);
                next(e);
            });
            return;
        }

        if (source === undefined) {
            return next(new Error("Bad request"));
        }
        options = _.chain(quote.parse(options || '')
            .map(function (x) {
                if (typeof(x) == "string") return x;
                return x.pattern;
            }))
            .filter(_.identity)
            .value();

        function textify(array) {
            return _.pluck(array || [], 'text').join("\n");
        }

		var reply_type = req.accepts([
			"application/json", "application/javascript", "text/javascript",
			"application/octet-stream", "application/x-object",
			"application/x-executable", "application/x-sharedlib",
			"binary", "text"
		]);

        compiler.compile(source, options, backendOptions, filters).then(
            function (result) {
/*
			var clean_output = function() {
				if(result.dirPath === undefined) return;
				fs.remove(result.dirPath);
				delete result.dirPath;
			};
			var should_clean = true;
*/
			switch(reply_type) {
				case "application/json":
				case "application/javascript":
				case "text/javascript":
					res.set("Content-Type", "application/json");
					res.end(JSON.stringify(result));
					break;
				case "application/octet-stream":
				case "application/x-object":
				case "application/x-executable":
				case "application/x-sharedlib":
				case "binary":
					if(filters.binary) {
						if(!fs.existsSync(result.output_file_path)) {
							logger.error(result.output_file_path + " not found");
							res.status(500).end();
							break;
						}
						res.set("Content-Type", "application/x-object");
						res.sendFile(result.output_file_path, null,
							function(e) {
								if(e) logger.warn(e);
						//		clean_output();
							});
						//should_clean = false;
						break;
					}
				default:
					res.set("Content-Type", "text/plain");
					try {
						if (!_.isEmpty(textBanner)) res.write("# " + textBanner + "\n");
						res.write(textify(result.asm));
						if(result.signal) res.write("\n# Compiler terminated by " + result.signal);
						else if (result.status !== 0) res.write("\n# Compiler exited with status " + String(result.status));
						if (!_.isEmpty(result.stdout)) res.write("\nStandard out:\n" + textify(result.stdout));
						if (!_.isEmpty(result.stderr)) res.write("\nStandard error:\n" + textify(result.stderr));
					} catch (ex) {
						re.write("Error handling request: " + ex);
					}
					res.end("\n");
					break;
			}
			//if(should_clean) clean_output();
            },
            function (error) {
                logger.error("Error", error);
                if (typeof(error) !== "string") {
                    if (error.code) {
                        if (typeof(error.stderr) === "string") {
                            error.stdout = utils.parseOutput(error.stdout);
                            error.stderr = utils.parseOutput(error.stderr);
                        }
                        error.status = 127;
                        switch(reply_type) {
					case "application/json":
					case "application/javascript":
					case "text/javascript":
						res.end(JSON.stringify(error));
						break;
					default:
						res.status(500);
						res.end("Failed to launch compiler due to " + error.code);
						break;
                        }
                        return;
                    }
                    error = "Internal Compiler Explorer error: " + (error.stack || error);
                }
			res.status(500);
			switch(reply_type) {
				case "application/json":
				case "application/javascript":
				case "text/javascript":
					res.end(JSON.stringify({status:-1, stderr:[{text:error}]}));
					break;
				default:
					res.end(error);
					break;
			}
            }
        );
    }, this);
}

module.exports = {
    CompileHandler: CompileHandler
};
