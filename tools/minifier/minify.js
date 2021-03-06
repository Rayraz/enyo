(function() {
	/* jshint node: true */
	var
		fs = require("fs"),
		path = require("path"),
		walker = require("walker"),
		uglify = require("uglify-js"),
		nopt = require("nopt"),
		less = require("less");
		RezInd = require('less-plugin-resolution-independence');

	var basename = path.basename(__filename),
		w = console.log,
		e = console.error,
		defaultEnyoLoc = "enyo",
		defaultLibLoc = "lib",
		opt;

	// Shimming path.relative with 0.8.8's version if it doesn't exist
	if(!path.relative){
		path.relative = require('./path-relative-shim').relative;
	}

	function printUsage() {
		w("Enyo 2.0 Minifier");
		w("Usage: " + __filename + " [Flags] [path/to/package.js]");
		w("Flags:");
		w("-no-less:", "Don't compile less; instead substitute css for less");
		w("-ri", "Perform LESS resolution-independence conversion of measurements i.e. px to rem");
		w("-no-alias:", "Don't use path macros");
		w("-alias:", "Give paths a macroized alias");
		w("-enyo ENYOPATH:", "Relative path to enyo folder (enyo)");
		w("-lib LIBPATH:", "Relative path to lib folder ($enyo/../lib)");
		w("-destdir DESTDIR:", "Target directory, prepended to any output file but skipped within generated files (current dir)");
		w("-output RELPATH/PREFIX:", "Folder + output file prefix, relative to DESTDIR (build/out)");
		w("-beautify:", "Output pretty version that's less compressed but has code on separate lines");
		w("-f", "Remote source mapping: from local path");
		w("-t", "Remote source mapping: to remote path");
		w("-gathering:", "Gathering libs to default location, so rewrite urls accordingly");
		w("-h, -?, -help:", "Show this message");
	}

	// properly split path based on platform
	function pathSplit(inPath) {
		var sep = process.platform == "win32" ? "\\" : "/";
		return inPath.split(sep);
	}

	function concatCss(sheets, doneCB) {
		w("");
		var blob = "";
		var addToBlob = function(sheet, codeIn) {
			var codeOut = "";
			var partials;
			var partial;
			var urlProp = "";
			var nested;
			var quote;
			var i;

			// Start new url() property
			var startUrlProp = function() {
				urlProp = "url(";
				nested = 0;
				quote = partial[0] === "'" || partial[0] === "\"" ? partial[0] : null;
			};

			// Fixes relative paths in url() property, ignores external urls and data uri's.
			var fixUrlPath = function() {
				var urlPath;
				var urlPathTrimmed;
				var relPath;

				// Find url path, ignore quotes in url string
				urlPath = urlProp.slice(4, -1);
				urlPathTrimmed = urlPath.split(/^['"]|['"]$/)[1];
				urlPath = urlPathTrimmed === undefined ? urlPath : urlPathTrimmed;

				// Handle the case url('') or url("").
				if (!urlPath) {
					return "url()";
				}
				// Skip an external url (one that starts with <protocol>: or just //, includes data:)
				if (/^([\w-]*:)|(\/\/)/.test(urlPath)) {
					return "url('" + urlPath + "')";
				}

				// If we are gathering libs to default location, rewrite urls beneath lib folder
				var dstSheet = (opt.gathering && sheet.indexOf(opt.lib) == 0) ?
					defaultLibLoc + sheet.substr(opt.lib.length) :
					sheet;

				// Make relative asset path from 'top-of-the-tree/build'
				var relPath = path.join("..", opt.relsrcdir, path.dirname(dstSheet), urlPath);
				if (process.platform == "win32") {
					relPath = pathSplit(relPath).join("/");
				}
				console.log("opt.relsrcdir:", opt.relsrcdir);
				console.log("sheet:", sheet);
				console.log("dstSheet:", dstSheet);
				console.log("urlPath:", urlPath);
				console.log("relPath:", relPath);
				return "url('" + relPath + "')";
			};

			// Finalize url() property
			var finalizeUrlProp = function() {
				// Fix url path
				urlProp = fixUrlPath(urlProp);
				// Add fixed urlPath and the rest of this partial
				// to final output
				codeOut += urlProp + partial.substr(i + 1);
				// Clear urlProp and continue to next partial.
				urlProp = "";
			};

			// For the "gathering" feature, we need to determine whether this sheet lives
			// inside a lib directory; normalizing the path makes it easier to check, below
			sheet = path.normalize(sheet);

			// Start scanning incoming code for url() properties.
			partials = codeIn.split(/url\(/ig);
			if(codeIn.substr(0,4) === "url(") {
				partial = partials[0];
				startUrlProp();
			}
			codeOut = partials.shift();

			// From this point onwards, each partial contains at least part of a url() property.
			iteratePartials: while (partials.length) {
				partial = partials.shift();

				// If we are not already constructing a url() property, create a new one.
				if (!urlProp.length) {
					startUrlProp();
				} else if(urlProp.length > 4) {
					urlProp += "url(";
					++nested;
				}

				// Complete url property
				for (i = 0; i < partial.length; i++) {
					urlProp += partial[i];

					// Quoted url property string ends with and un-escaped quote, followed by a closing parenthesis.
					if (quote &&
						partial[i] === quote &&
						partial[i - 1] !== "\\" &&
						partial[i + 1] === ")") {
						// Append closing parenthesis;
						urlProp += partial[i + 1];
						++i;
						finalizeUrlProp();
						continue iteratePartials;
					}

					// Unquoted url property string ends with an un-escaped closing parenthesis.
					else if (!quote &&
						nested === 0 &&
						partial[i] === ")" &&
						partial[i - 1] !== "\\") {
						finalizeUrlProp();
						continue iteratePartials;
					}

					// Intercept un-escaped nested parenthesis in unquoted url() value strings.
					// Unbalanced parenthesis are escaped and can be ignored.
					else if(!quote &&
					partial[i] === "(" &&
					partial[i - 1] !== "\\") {
						++nested;
					}
					else if(!quote &&
						partial[i] === ")" &&
						partial[i - 1] !== "\\") {
						--nested;
					}
				}
			}

			blob += "\n/* " + path.relative(process.cwd(), sheet) + " */\n\n" + codeOut + "\n";
		};
		// Pops one sheet off the sheets[] array, reads (and parses if less), and then
		// recurses again from the async callback until no sheets left, then calls doneCB
		function readAndParse() {
			var sheet = sheets.shift(),
				ri = new RezInd();
			if (sheet) {
				w(sheet);
				var isLess = (sheet.slice(-4) == "less");
				var isCss = (sheet.slice(-3) == "css");
				if (isLess && (opt.less !== true)) {
					sheet = sheet.slice(0, sheet.length-4) + "css";
					isLess = false;
					w(" (Substituting CSS: " + sheet + ")");
				}
				var code = fs.readFileSync(sheet, "utf8");
				if (isLess || isCss) {
					var parser = new(less.Parser)({filename:sheet, paths:[path.dirname(sheet)], relativeUrls:true});
					parser.parse(code, function (err, tree) {
						if (err) {
							console.error(err);
						} else {
							var generatedCss;
							if (opt.ri) {
								generatedCss = tree.toCSS({plugins: [ri]});
							} else {
								generatedCss = tree.toCSS();
							}
							addToBlob(sheet, generatedCss);
						}
						readAndParse(sheets);
					});
				} else {
					addToBlob(sheet, code);
					readAndParse(sheets);
				}
			} else {
				doneCB(blob);
			}
		}
		readAndParse();
	}

	var concatJs = function(loader, scripts) {
		w("");
		var blob = "";
		for (var i=0, script; (script=scripts[i]); i++) {
			w(script);
			blob += "\n// " + path.relative(process.cwd(), script) + "\n" + compressJsFile(script) + "\n";
		}
		return blob;
	};

	var compressJsFile = function(inPath) {
		var outputOpts = {
//			beautify: false,
//			indent_level: 4,
			ascii_only: true
		};
		if (opt.beautify) {
			outputOpts.beautify = true;
			outputOpts.indent_level = 4;
		}
		var result = uglify.minify(inPath, {output: outputOpts});
		return result.code;
	};

	var walkerFinished = function(loader, chunks) {
		var outfolder = path.dirname(path.join(opt.destdir, opt.output));
		var exists = fs.existsSync || path.existsSync;
		var currChunk = 1;
		var topDepends;
		if (outfolder != "." && !exists(outfolder)) {
			fs.mkdirSync(outfolder);
		}
		if ((chunks.length == 1) && (typeof chunks[0] == "object")) {
			topDepends = false;
			currChunk = "";
		} else {
			topDepends = [];
		}
		var processNextChunk = function(done) {
			if (chunks.length > 0) {
				var chunk = chunks.shift();
				if (typeof chunk == "string") {
					topDepends.push(chunk);
					processNextChunk(done);
				} else {
					concatCss(chunk.sheets, function(css) {
						if (css.length) {
							w("");
							var cssFile = opt.output + currChunk + ".css";
							fs.writeFileSync(path.resolve(opt.destdir, cssFile), css, "utf8");
							if (topDepends) {
								topDepends.push(cssFile);
							}
						}
						var js = concatJs(loader, chunk.scripts);
						if (js.length) {
							w("");
							var jsFile = opt.output + currChunk + ".js";
							fs.writeFileSync(path.resolve(opt.destdir, jsFile), js, "utf8");
							if (topDepends) {
								topDepends.push(jsFile);
							}
						}
						currChunk++;
						processNextChunk(done);
					});
				}
			} else {
				done();
			}
		};
		processNextChunk(function() {
			if (topDepends) {
				var js = "";
				// Add path aliases to the mapped sources
				for (var i=0; i<opt.mapfrom.length; i++) {
					js = js + "enyo.path.addPath(\"" + opt.mapfrom[i] + "\", \"" + opt.mapto[i] + "\");\n";
				}
				// Override the default rule that $lib lives next to $enyo, since enyo may be remote
				js = js + "enyo.path.addPath(\"lib\", \"lib\");\n";
				// Add depends for all of the top-level files
				js = js + "enyo.depends(\n\t\"" + topDepends.join("\",\n\t\"") + "\"\n);";
				fs.writeFileSync(path.resolve(opt.destdir, opt.output + ".js"), js, "utf8");
				fs.writeFileSync(path.resolve(opt.destdir, opt.output + ".css"), "/* CSS loaded via enyo.depends() call in " + opt.output + ".js */", "utf8");
			}

			w("");
			w("done.");
			w("");

			// required to properly terminate a
			// node.process.fork() call, as defined by
			// <http://nodejs.org/api/child_process.html#child_process_child_process_fork_modulepath_args_options>
			process.exit(0);
		});
	};

	var knownOpts = {
		"alias": Boolean,
		"enyo": String,   // relative path
		"lib": String,    // relative path
		"destdir": path,  // absolute path (resolved by nopt)
		"srcdir": path,   // absolute path (resolved by nopt)
		"output": String, // relative path
		"help": Boolean,
		"beautify": Boolean,
		"mapfrom": [String, Array],
		"mapto": [String, Array],
		"gathering": Boolean,
		"ri": Boolean
	};

	var shortHands = {
		"alias": ['--alias'],
		"enyo": ['--enyo'],
		"lib": ['--lib'],
		"srcdir": ['--srcdir'],
		"destdir": ['--destdir'],
		"output": ['--output'],
		"h": ['--help'],
		"?": ['--help'],
		"help": ['--help'],
		"beautify": ['--beautify'],
		"f": ['--mapfrom'],
		"t": ['--mapto'],
		"ri": ['--ri']
	};

	opt = nopt(knownOpts, shortHands, process.argv, 2);
	opt.packagejs = opt.argv.remain[0] || "package.js";
	opt.srcdir = opt.srcdir || process.cwd();
	if (opt.packagejs) {
		// walker only works from top-level package.js...
		process.chdir(path.dirname(opt.packagejs));
	}
	// ...but we still want to (relatively) track the top of the
	// tree, because this is the root from which the LESS sheets
	// are resolved (unlike the JS dependencies, which are
	// resolved from the folder of the top-level package.js).
	opt.relsrcdir = path.relative(opt.srcdir, process.cwd());

	if (opt.help) {
		printUsage();
		process.exit();
	}

	// Send message to parent node process, if any
	process.on('uncaughtException', function (err) {
		e(err.stack);
		if (process.send) {
			// only available if parent-process is node
			process.send({error: err});
		}
		process.exit(1);
	});
	// receive error messages from child node processes
	process.on('message', function(msg) {
		console.dir(basename, msg);
		if (msg.error && msg.error.stack) {
			console.error(basename, msg.error.stack);
		}
		if (process.send) {
			process.send(msg);
		}
	});

	opt.destdir = opt.destdir || process.cwd();
	opt.output = opt.output || "build/out";
	if (path.resolve(opt.output) === opt.output) {
		throw new Error("-output must be a relative path prefix");
	}

	opt.enyo = opt.enyo || defaultEnyoLoc;

	opt.lib = opt.lib || path.join(opt.enyo, "../lib");
	opt.gathering = opt.gathering && (opt.lib != defaultLibLoc);

	w(opt);
	walker.init(opt.enyo, opt.lib, opt.mapfrom, opt.mapto);
	walker.walk(path.basename(opt.packagejs), walkerFinished);

})();
