/**
 * @fileoverview Standard library functions
 * @author Jeff Parsons <Jeff@pcjs.org>
 * @copyright © 2012-2022 Jeff Parsons
 * @license MIT <https://www.pcjs.org/LICENSE.txt>
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 */

import StdIO from "../../machines/modules/stdio.js";

/**
 * @class StdLib
 * @property {number} argc
 * @property {Array.<string>} argv
 */
export default class StdLib {
    /**
     * StdLib()
     *
     * @this {StdLib}
     */
    constructor()
    {
        this.stdio = new StdIO();
        [this.argc, this.argv] = this.parseArgs(process.argv);
    }

    /**
     * getArgs(s)
     *
     * @this {StdLib}
     * @param {string} [s]
     * @returns {Array} [argc, argv]
     */
    getArgs(s)
    {
        if (s) {
            let args = s.split(' ');
            return this.parseArgs(args, 0);
        }
        return [this.argc, this.argv];
    }

    /**
     * parseArgs(args, i)
     *
     * Any argument value preceded by a double-hyphen or long-dash switch (eg, "--option value") is
     * saved in argv with the switch as the key (eg, argv["option"] == "value").
     *
     * If there are multiple arguments preceded by the same double-hyphen switch, then the argv entry
     * becomes an array (eg, argv["option"] == ["value1","value2"]).
     *
     * If a double-hyphen switch is followed by another switch (or by nothing, if it's the last argument),
     * then the value of the switch will be a boolean instead of a string (eg, argv["option"] == true).
     *
     * Single-hyphen switches are different: every character following a single hyphen is transformed into
     * a boolean value (eg, "-abc" produces argv["a"] == true, argv["b"] == true, and argv["c"] == true).
     *
     * Only arguments NOT preceded by (or part of) a switch are pushed onto the argv array; they can be
     * accessed as argv[i], argv[i+1], etc.
     *
     * In addition, when the initial i >= 1, then argv[0] is set to the concatenation of all args, starting
     * with args[i], and the first non-switch argument begins at argv[1].
     *
     * @this {StdLib}
     * @param {Array.<string>} [args]
     * @param {number} [i] (default is 1, because if you're passing process.argv, process.argv[0] is useless)
     * @returns {Array} [argc, argv]
     */
    parseArgs(args, i = 1)
    {
        let argc = 0;
        let argv = [];
        if (i) argv.push(args.slice(i++).join(' '));
        while (i < args.length) {
            let j, sSep;
            let sArg = args[i++];
            if (!sArg.indexOf(sSep = "--") || !sArg.indexOf(sSep = "—")) {
                sArg = sArg.substr(sSep.length);
                let sValue = true;
                j = sArg.indexOf("=");
                if (j > 0) {
                    sValue = sArg.substr(j + 1);
                    sArg = sArg.substr(0, j);
                    sValue = (sValue == "true") ? true : ((sValue == "false") ? false : sValue);
                }
                else if (i < args.length && args[i][0] != '-') {
                    sValue = args[i++];
                }
                if (!argv.hasOwnProperty(sArg)) {
                    argv[sArg] = sValue;
                }
                else {
                    if (!Array.isArray(argv[sArg])) {
                        argv[sArg] = [argv[sArg]];
                    }
                    argv[sArg].push(sValue);
                }
                continue;
            }
            if (!sArg.indexOf("-")) {
                for (j = 1; j < sArg.length; j++) {
                    let ch = sArg.charAt(j);
                    if (argv[ch] === undefined) {
                        argv[ch] = true;
                    }
                }
                continue;
            }
            argv.push(sArg);
        }
        argc = argv.length;
        return [argc, argv];
    }

    /**
     * printf(format, ...args)
     *
     * @this {StdLib}
     * @param {string} format
     * @param {...} args
     */
    printf(format, ...args)
    {
        process.stdout.write(this.stdio.sprintf(format, ...args));
    }
}
