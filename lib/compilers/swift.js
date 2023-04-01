const Compile = require('../base-compiler'),
    logger = require('../logger').logger;

function compileSwift(info, env) {
    const compiler = new Compile(info, env);

    compiler.handlePostProcessResult = function (result, postResult) {
		if(postResult.signal) {
			result.asm = "<Error during post processing: " + postResult.signal + ">";
			logger.error("Error during post-processing", result);
		} else {
			result.asm = postResult.stdout;
			// Seems swift-demangle like to exit with error 1
			if (postResult.status !== 0 && !result.asm) {
				result.asm = util.format("<Error during post processing: %d>", postResult.status);
				logger.error("Error during post-processing", result);
			}
		}
		return result;
    };
    return compiler.initialise();
}

module.exports = compileSwift;
