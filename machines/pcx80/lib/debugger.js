/**
 * @fileoverview Implements the PCx80 Debugger component
 * @author Jeff Parsons <Jeff@pcjs.org>
 * @copyright © 2012-2022 Jeff Parsons
 * @license MIT <https://www.pcjs.org/LICENSE.txt>
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 */

"use strict";

if (typeof module !== "undefined") {
    var Str = require("../../shared/lib/strlib");
    var Usr = require("../../shared/lib/usrlib");
    var Web = require("../../shared/lib/weblib");
    var Component = require("../../shared/lib/component");
    var DbgLib = require("../../shared/lib/debugger");
    var Keys = require("../../shared/lib/keys");
    var State = require("../../shared/lib/state");
    var PCx80 = require("./defines");
    var CPUDefX80 = require("./cpudef");
    var CPUx80 = require("./cpu");
    var MemoryX80 = require("./memory");
    var MessagesX80 = require("./messages");
}

/**
 * DebuggerX80 Address Object
 *
 *      addr            address
 *      fTemporary      true if this is a temporary breakpoint address
 *      sCmd            set for breakpoint addresses if there's an associated command string
 *      aCmds           preprocessed commands (from sCmd)
 *
 * @typedef {{
 *      addr:(number|undefined),
 *      fTemporary:(boolean|undefined),
 *      sCmd:(string|undefined),
 *      aCmds:(Array.<string>|undefined)
 * }}
 */
var DbgAddrX80;

/**
 * TODO: The Closure Compiler treats ES6 classes as 'struct' rather than 'dict' by default,
 * which would force us to declare all class properties in the constructor, as well as prevent
 * us from defining any named properties.  So, for now, we mark all our classes as 'unrestricted'.
 *
 * @unrestricted
 */
class DebuggerX80 extends DbgLib {
    /**
     * DebuggerX80(parmsDbg)
     *
     * The DebuggerX80 component supports the following optional (parmsDbg) properties:
     *
     *      commands: string containing zero or more commands, separated by ';'
     *
     *      messages: string containing zero or more message categories to enable;
     *      multiple categories must be separated by '|' or ';'.  Parsed by messageInit().
     *
     * The DebuggerX80 component is an optional component that implements a variety of user
     * commands for controlling the CPU, dumping and editing memory, etc.
     *
     * @this {DebuggerX80}
     * @param {Object} parmsDbg
     */
    constructor(parmsDbg)
    {
        super("Debugger", parmsDbg, -1);

        if (DEBUGGER) {

            this.style = DebuggerX80.STYLE_8080;

            /*
             * Most commands that require an address call parseAddr(), which defaults to dbgAddrNextCode
             * or dbgAddrNextData when no address has been given.  doDump() and doUnassemble(), in turn,
             * update dbgAddrNextData and dbgAddrNextCode, respectively, when they're done.
             *
             * For TEMPORARY breakpoint addresses, we set fTemporary to true, so that they can be automatically
             * cleared when they're hit.
             */
            this.dbgAddrNextCode = this.newAddr();
            this.dbgAddrNextData = this.newAddr();
            this.dbgAddrAssemble = this.newAddr();

            /*
             * aSymbolTable is an array of SymbolTable objects, one per ROM or other chunk of address space,
             * where each object contains the following properties:
             *
             *      sModule
             *      addr (physical address, if any; eg, symbols for a ROM)
             *      len
             *      aSymbols
             *      aOffsets
             *
             * See addSymbols() for more details, since that's how callers add sets of symbols to the table.
             */
            this.aSymbolTable = [];

            /*
             * clearBreakpoints() initializes the breakpoints lists: aBreakExec is a list of addresses
             * to halt on whenever attempting to execute an instruction at the corresponding address,
             * and aBreakRead and aBreakWrite are lists of addresses to halt on whenever a read or write,
             * respectively, occurs at the corresponding address.
             *
             * NOTE: Curiously, after upgrading the Google Closure Compiler from v20141215 to v20150609,
             * the resulting compiled code would crash in clearBreakpoints(), because the (renamed) aBreakRead
             * property was already defined.  To eliminate whatever was confusing the Closure Compiler, I've
             * explicitly initialized all the properties that clearBreakpoints() (re)initializes.
             */
            this.aBreakExec = this.aBreakRead = this.aBreakWrite = [];
            this.clearBreakpoints();

            /*
             * The new "bn" command allows you to specify a number of instructions to execute and then stop;
             * "bn 0" disables any outstanding count.
             */
            this.nBreakIns = 0;

            /*
             * Execution history is allocated by historyInit() whenever checksEnabled() conditions change.
             * Execution history is updated whenever the CPU calls checkInstruction(), which will happen
             * only when checksEnabled() returns true (eg, whenever one or more breakpoints have been set).
             * This ensures that, by default, the CPU runs as fast as possible.
             */
            this.historyInit();

            /*
             * Initialize DebuggerX80 message support
             */
            this.afnDumpers = {};
            this.messageInit(parmsDbg['messages']);

            this.sInitCommands = parmsDbg['commands'];

            /*
             * Make it easier to access Debugger commands from an external REPL, like the WebStorm "live" console
             * window; eg:
             *
             *      pcX80('r')
             *      pcX80('dw 0:0')
             *      pcX80('h')
             *      ...
             */
            var dbg = this;
            if (window) {
                if (window[PCx80.APPCLASS] === undefined) {
                    window[PCx80.APPCLASS] = function(s) { return dbg.doCommands(s); };
                }
            } else {
                if (global[PCx80.APPCLASS] === undefined) {
                    global[PCx80.APPCLASS] = function(s) { return dbg.doCommands(s); };
                }
            }

        }   // endif DEBUGGER
    }

    /**
     * initBus(bus, cpu, dbg)
     *
     * @this {DebuggerX80}
     * @param {ComputerX80} cmp
     * @param {BusX80} bus
     * @param {CPUStateX80} cpu
     * @param {DebuggerX80} dbg
     */
    initBus(cmp, bus, cpu, dbg)
    {
        this.bus = bus;
        this.cpu = cpu;
        this.cmp = cmp;

        /*
         * Re-initialize Debugger message support if necessary
         */
        var sMessages = cmp.getMachineParm('messages');
        if (sMessages) this.messageInit(sMessages);

        this.aaOpDescs = DebuggerX80.aaOpDescs;

        this.messageDump(MessagesX80.BUS,  function onDumpBus(asArgs) { dbg.dumpBus(asArgs); });

        this.setReady();
    }

    /**
     * setBinding(sHTMLType, sBinding, control, sValue)
     *
     * @this {DebuggerX80}
     * @param {string} sHTMLType is the type of the HTML control (eg, "button", "list", "text", "submit", "textarea", "canvas")
     * @param {string} sBinding is the value of the 'binding' parameter stored in the HTML control's "data-value" attribute (eg, "debugInput")
     * @param {HTMLElement} control is the HTML control DOM object (eg, HTMLButtonElement)
     * @param {string} [sValue] optional data value
     * @return {boolean} true if binding was successful, false if unrecognized binding request
     */
    setBinding(sHTMLType, sBinding, control, sValue)
    {
        var dbg = this;
        switch (sBinding) {

        case "debugInput":
            this.bindings[sBinding] = control;
            this.controlDebug = /** @type {HTMLInputElement} */ (control);
            /*
             * For halted machines, this is fine, but for auto-start machines, it can be annoying.
             *
             *      control.focus();
             */
            control.onkeydown = function onKeyDownDebugInput(event) {
                var sCmd;
                if (event.keyCode == Keys.KEYCODE.CR) {
                    sCmd = dbg.controlDebug.value;
                    dbg.controlDebug.value = "";
                    dbg.doCommands(sCmd, true);
                }
                else if (event.keyCode == Keys.KEYCODE.ESC) {
                    dbg.controlDebug.value = sCmd = "";
                }
                else {
                    if (event.keyCode == Keys.KEYCODE.UP) {
                        sCmd = dbg.getPrevCommand();
                    }
                    else if (event.keyCode == Keys.KEYCODE.DOWN) {
                        sCmd = dbg.getNextCommand();
                    }
                    if (sCmd != null) {
                        var cch = sCmd.length;
                        dbg.controlDebug.value = sCmd;
                        dbg.controlDebug.setSelectionRange(cch, cch);
                    }
                }
                if (sCmd != null && event.preventDefault) event.preventDefault();
            };
            return true;

        case "debugEnter":
            this.bindings[sBinding] = control;
            Web.onClickRepeat(
                control,
                500, 100,
                function onClickDebugEnter(fRepeat) {
                    if (dbg.controlDebug) {
                        var sCmds = dbg.controlDebug.value;
                        dbg.controlDebug.value = "";
                        dbg.doCommands(sCmds, true);
                        return true;
                    }
                    if (DEBUG) dbg.log("no debugger input buffer");
                    return false;
                }
            );
            return true;

        case "step":
            this.bindings[sBinding] = control;
            Web.onClickRepeat(
                control,
                500, 100,
                function onClickStep(fRepeat) {
                    var fCompleted = false;
                    if (!dbg.isBusy(true)) {
                        dbg.setBusy(true);
                        fCompleted = dbg.stepCPU(fRepeat? 1 : 0);
                        dbg.setBusy(false);
                    }
                    return fCompleted;
                }
            );
            return true;

        default:
            break;
        }
        return false;
    }

    /**
     * updateFocus()
     *
     * @this {DebuggerX80}
     */
    updateFocus()
    {
        if (this.controlDebug) this.controlDebug.focus();
    }

    /**
     * getAddr(dbgAddr, fWrite, nb)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80|null|undefined} dbgAddr
     * @param {boolean} [fWrite]
     * @param {number} [nb] number of bytes to check (1 or 2); default is 1
     * @return {number} is the corresponding linear address, or CPUDefX80.ADDR_INVALID
     */
    getAddr(dbgAddr, fWrite, nb)
    {
        var addr = dbgAddr && dbgAddr.addr;
        if (addr == null) {
            addr = CPUDefX80.ADDR_INVALID;
        }
        return addr;
    }

    /**
     * getByte(dbgAddr, inc)
     *
     * We must route all our memory requests through the CPU now, in case paging is enabled.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} [inc]
     * @return {number}
     */
    getByte(dbgAddr, inc)
    {
        var b = 0xff;
        var addr = this.getAddr(dbgAddr, false, 1);
        if (addr !== CPUDefX80.ADDR_INVALID) {
            b = this.bus.getByteDirect(addr);
            if (inc) this.incAddr(dbgAddr, inc);
        }
        return b;
    }

    /**
     * getWord(dbgAddr, fAdvance)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {boolean} [fAdvance]
     * @return {number}
     */
    getWord(dbgAddr, fAdvance)
    {
        return this.getShort(dbgAddr, fAdvance? 2 : 0);
    }

    /**
     * getShort(dbgAddr, inc)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} [inc]
     * @return {number}
     */
    getShort(dbgAddr, inc)
    {
        var w = 0xffff;
        var addr = this.getAddr(dbgAddr, false, 2);
        if (addr !== CPUDefX80.ADDR_INVALID) {
            w = this.bus.getShortDirect(addr);
            if (inc) this.incAddr(dbgAddr, inc);
        }
        return w;
    }

    /**
     * setByte(dbgAddr, b, inc)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} b
     * @param {number} [inc]
     */
    setByte(dbgAddr, b, inc)
    {
        var addr = this.getAddr(dbgAddr, true, 1);
        if (addr !== CPUDefX80.ADDR_INVALID) {
            this.bus.setByteDirect(addr, b);
            if (inc) this.incAddr(dbgAddr, inc);
            this.cpu.updateCPU(true);           // we set fForce to true in case video memory was the target
        }
    }

    /**
     * setShort(dbgAddr, w, inc)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} w
     * @param {number} [inc]
     */
    setShort(dbgAddr, w, inc)
    {
        var addr = this.getAddr(dbgAddr, true, 2);
        if (addr !== CPUDefX80.ADDR_INVALID) {
            this.bus.setShortDirect(addr, w);
            if (inc) this.incAddr(dbgAddr, inc);
            this.cpu.updateCPU(true);           // we set fForce to true in case video memory was the target
        }
    }

    /**
     * newAddr(addr)
     *
     * Returns a NEW DbgAddrX80 object, initialized with specified values and/or defaults.
     *
     * @this {DebuggerX80}
     * @param {number} [addr]
     * @return {DbgAddrX80}
     */
    newAddr(addr)
    {
        return {addr: addr, fTemporary: false};
    }

    /**
     * setAddr(dbgAddr, addr)
     *
     * Updates an EXISTING DbgAddrX80 object, initialized with specified values and/or defaults.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} addr
     * @return {DbgAddrX80}
     */
    setAddr(dbgAddr, addr)
    {
        dbgAddr.addr = addr;
        dbgAddr.fTemporary = false;
        return dbgAddr;
    }

    /**
     * packAddr(dbgAddr)
     *
     * Packs a DbgAddrX80 object into an Array suitable for saving in a machine state object.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @return {Array}
     */
    packAddr(dbgAddr)
    {
        return [dbgAddr.addr, dbgAddr.fTemporary];
    }

    /**
     * unpackAddr(aAddr)
     *
     * Unpacks a DbgAddrX80 object from an Array created by packAddr() and restored from a saved machine state.
     *
     * @this {DebuggerX80}
     * @param {Array} aAddr
     * @return {DbgAddrX80}
     */
    unpackAddr(aAddr)
    {
        return {addr: aAddr[0], fTemporary: aAddr[1]};
    }

    /**
     * parseAddr(sAddr, fCode, fNoChecks)
     *
     * Address evaluation and validation (eg, range checks) are no longer performed at this stage.  That's
     * done later, by getAddr(), which returns CPUDefX80.ADDR_INVALID for invalid segments, out-of-range offsets,
     * etc.  The Debugger's low-level get/set memory functions verify all getAddr() results, but even if an
     * invalid address is passed through to the Bus memory interfaces, the address will simply be masked with
     * BusX80.nBusLimit; in the case of CPUDefX80.ADDR_INVALID, that will generally refer to the top of the physical
     * address space.
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sAddr
     * @param {boolean} [fCode] (true if target is code, false if target is data)
     * @param {boolean} [fNoChecks] (true when setting breakpoints that may not be valid now, but will be later)
     * @return {DbgAddrX80|null|undefined}
     */
    parseAddr(sAddr, fCode, fNoChecks)
    {
        var dbgAddr;
        var dbgAddrNext = (fCode? this.dbgAddrNextCode : this.dbgAddrNextData);
        var addr = dbgAddrNext.addr;
        if (sAddr !== undefined) {
            sAddr = this.parseReference(sAddr) || sAddr;
            dbgAddr = this.findSymbolAddr(sAddr);
            if (dbgAddr) return dbgAddr;
            addr = this.parseExpression(sAddr);
        }
        if (addr != null) {
            dbgAddr = this.newAddr(addr);
        }
        return dbgAddr;
    }

    /**
     * parseAddrOptions(dbdAddr, sOptions)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {string} [sOptions]
     */
    parseAddrOptions(dbgAddr, sOptions)
    {
        if (sOptions) {
            var a = sOptions.match(/(['"])(.*?)\1/);
            if (a) {
                dbgAddr.aCmds = this.parseCommand(dbgAddr.sCmd = a[2]);
            }
        }
    }

    /**
     * incAddr(dbgAddr, inc)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} [inc] contains value to increment dbgAddr by (default is 1)
     */
    incAddr(dbgAddr, inc)
    {
        if (dbgAddr.addr != null) {
            dbgAddr.addr += (inc || 1);
        }
    }

    /**
     * toHexOffset(off)
     *
     * @this {DebuggerX80}
     * @param {number|null|undefined} [off]
     * @return {string} the hex representation of off
     */
    toHexOffset(off)
    {
        return Str.toHex(off, 4);
    }

    /**
     * toHexAddr(dbgAddr)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @return {string} the hex representation of the address
     */
    toHexAddr(dbgAddr)
    {
        return this.toHexOffset(dbgAddr.addr);
    }

    /**
     * getSZ(dbgAddr, cchMax)
     *
     * Gets zero-terminated (aka "ASCIIZ") string from dbgAddr.  It also stops at the first '$', in case this is
     * a '$'-terminated string -- mainly because I'm lazy and didn't feel like writing a separate get() function.
     * Yes, a zero-terminated string containing a '$' will be prematurely terminated, and no, I don't care.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {number} [cchMax] (default is 256)
     * @return {string} (and dbgAddr advanced past the terminating zero)
     */
    getSZ(dbgAddr, cchMax)
    {
        var s = "";
        cchMax = cchMax || 256;
        while (s.length < cchMax) {
            var b = this.getByte(dbgAddr, 1);
            if (!b || b == 0x24 || b >= 127) break;
            s += (b >= 32? String.fromCharCode(b) : '.');
        }
        return s;
    }

    /**
     * dumpBlocks(aBlocks, sAddr)
     *
     * @this {DebuggerX80}
     * @param {Array} aBlocks
     * @param {string} [sAddr] (optional block address)
     */
    dumpBlocks(aBlocks, sAddr)
    {
        var addr = 0, i = 0, n = aBlocks.length;

        if (sAddr) {
            addr = this.getAddr(this.parseAddr(sAddr));
            if (addr === CPUDefX80.ADDR_INVALID) {
                this.println("invalid address: " + sAddr);
                return;
            }
            i = addr >>> this.bus.nBlockShift;
            n = 1;
        }

        this.println("blockid   physical   blockaddr   used    size    type");
        this.println("--------  ---------  ----------  ------  ------  ----");

        var typePrev = -1, cPrev = 0;
        while (n--) {
            var block = aBlocks[i];
            if (block.type == typePrev) {
                if (!cPrev++) this.println("...");
            } else {
                typePrev = block.type;
                var sType = MemoryX80.TYPE.NAMES[typePrev];
                if (block) {
                    this.println(Str.toHex(block.id) + "  %" + Str.toHex(i << this.bus.nBlockShift) + "  %%" + Str.toHex(block.addr) + "  " + Str.toHexWord(block.used) + "  " + Str.toHexWord(block.size) + "  " + sType);
                }
                if (typePrev != MemoryX80.TYPE.NONE) typePrev = -1;
                cPrev = 0;
            }
            addr += this.bus.nBlockSize;
            i++;
        }
    }

    /**
     * dumpBus(asArgs)
     *
     * Dumps Bus allocations.
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs (asArgs[0] is an optional block address)
     */
    dumpBus(asArgs)
    {
        this.dumpBlocks(this.bus.aMemBlocks, asArgs[0]);
    }

    /**
     * dumpHistory(sPrev, sLines)
     *
     * If sLines is not a number, it can be a instruction filter.  However, for the moment, the only
     * supported filter is "call", which filters the history buffer for all CALL and RET instructions
     * from the specified previous point forward.
     *
     * @this {DebuggerX80}
     * @param {string} [sPrev] is a (decimal) number of instructions to rewind to (default is 10)
     * @param {string} [sLines] is a (decimal) number of instructions to print (default is, again, 10)
     */
    dumpHistory(sPrev, sLines)
    {
        var sMore = "";
        var cHistory = 0;
        var iHistory = this.iOpcodeHistory;
        var aHistory = this.aOpcodeHistory;

        if (aHistory.length) {
            var nPrev = +sPrev || this.nextHistory;
            var nLines = +sLines || 10;

            if (isNaN(nPrev)) {
                nPrev = nLines;
            } else {
                sMore = "more ";
            }

            if (nPrev > aHistory.length) {
                this.println("note: only " + aHistory.length + " available");
                nPrev = aHistory.length;
            }

            iHistory -= nPrev;
            if (iHistory < 0) {
                /*
                 * If the dbgAddr of the last aHistory element contains a valid selector, wrap around.
                 */
                if (aHistory[aHistory.length - 1].addr == null) {
                    nPrev = iHistory + nPrev;
                    iHistory = 0;
                } else {
                    iHistory += aHistory.length;
                }
            }

            var aFilters = [];
            if (sLines == "call") {
                nLines = 100000;
                aFilters = ["CALL"];
            }

            if (sPrev !== undefined) {
                this.println(nPrev + " instructions earlier:");
            }

            /*
             * TODO: The following is necessary to prevent dumpHistory() from causing additional (or worse, recursive)
             * faults due to segmented addresses that are no longer valid, but the only alternative is to dramatically
             * increase the amount of memory used to store instruction history (eg, storing copies of all the instruction
             * bytes alongside the execution addresses).
             *
             * For now, we're living dangerously, so that our history dumps actually work.
             *
             *      this.nSuppressBreaks++;
             *
             * If you re-enable this protection, be sure to re-enable the decrement below, too.
             */
            var sDump = "";
            while (nLines > 0 && iHistory != this.iOpcodeHistory) {

                var dbgAddr = aHistory[iHistory++];
                if (dbgAddr.addr == null) break;

                /*
                 * We must create a new dbgAddr from the address in aHistory, because dbgAddr was
                 * a reference, not a copy, and we don't want getInstruction() modifying the original.
                 */
                var dbgAddrNew = this.newAddr(dbgAddr.addr);

                var sComment = "history";
                var nSequence = nPrev--;
                if (MAXDEBUG && dbgAddr.cycleCount != null) {
                    sComment = "cycles";
                    nSequence = dbgAddr.cycleCount;
                }

                var sInstruction = this.getInstruction(dbgAddrNew, sComment, nSequence);

                if (!aFilters.length || sInstruction.indexOf(aFilters[0]) >= 0) {
                    sDump += sInstruction + "\n";
                }

                /*
                 * If there were OPERAND or ADDRESS overrides on the previous instruction, getInstruction()
                 * will have automatically disassembled additional bytes, so skip additional history entries.
                 */
                if (dbgAddrNew.cOverrides) {
                    iHistory += dbgAddrNew.cOverrides; nLines -= dbgAddrNew.cOverrides; nPrev -= dbgAddrNew.cOverrides;
                }

                if (iHistory >= aHistory.length) iHistory = 0;
                this.nextHistory = nPrev;
                cHistory++;
                nLines--;
            }
            if (sDump) this.println(sDump);
            /*
             * See comments above.
             *
             *      this.nSuppressBreaks--;
             */
        }

        if (!cHistory) {
            this.println("no " + sMore + "history available");
            this.nextHistory = undefined;
        }
    }

    /**
     * messageInit(sEnable)
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sEnable contains zero or more message categories to enable, separated by '|'
     */
    messageInit(sEnable)
    {
        this.dbg = this;
        this.bitsMessage = this.bitsWarning = MessagesX80.WARN;
        this.sMessagePrev = null;
        this.aMessageBuffer = [];
        /*
         * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
         * but externally, we allow the user to specify "keys"; "kbd" is also allowed as shorthand for "keyboard".
         */
        var aEnable = this.parseCommand(sEnable.replace("keys","key").replace("kbd","keyboard"), false, '|');
        if (aEnable.length) {
            for (var m in MessagesX80.CATEGORIES) {
                if (Usr.indexOf(aEnable, m) >= 0) {
                    this.bitsMessage |= MessagesX80.CATEGORIES[m];
                    this.println(m + " messages enabled");
                }
            }
        }
    }

    /**
     * messageDump(bitMessage, fnDumper)
     *
     * @this {DebuggerX80}
     * @param {number} bitMessage is one Messages category flag
     * @param {function(Array.<string>)} fnDumper is a function the Debugger can use to dump data for that category
     * @return {boolean} true if successfully registered, false if not
     */
    messageDump(bitMessage, fnDumper)
    {
        for (var m in MessagesX80.CATEGORIES) {
            if (bitMessage == MessagesX80.CATEGORIES[m]) {
                this.afnDumpers[m] = fnDumper;
                return true;
            }
        }
        return false;
    }

    /**
     * getRegIndex(sReg, off)
     *
     * @this {DebuggerX80}
     * @param {string} sReg
     * @param {number} [off] optional offset into sReg
     * @return {number} register index, or -1 if not found
     */
    getRegIndex(sReg, off)
    {
        var i;
        sReg = sReg.toUpperCase();
        if (off == null) {
            i = Usr.indexOf(DebuggerX80.REGS, sReg);
        } else {
            i = Usr.indexOf(DebuggerX80.REGS, sReg.substr(off, 2));
            if (i < 0) i = Usr.indexOf(DebuggerX80.REGS, sReg.substr(off, 1));
        }
        return i;
    }

    /**
     * getRegString(iReg)
     *
     * @this {DebuggerX80}
     * @param {number} iReg
     * @return {string}
     */
    getRegString(iReg)
    {
        var cch = 0;
        var n = this.getRegValue(iReg);
        if (n !== undefined) {
            switch(iReg) {
            case DebuggerX80.REG_A:
            case DebuggerX80.REG_B:
            case DebuggerX80.REG_C:
            case DebuggerX80.REG_D:
            case DebuggerX80.REG_E:
            case DebuggerX80.REG_H:
            case DebuggerX80.REG_L:
            case DebuggerX80.REG_M:
                cch = 2;
                break;
            case DebuggerX80.REG_BC:
            case DebuggerX80.REG_DE:
            case DebuggerX80.REG_HL:
            case DebuggerX80.REG_SP:
            case DebuggerX80.REG_PC:
            case DebuggerX80.REG_PS:
            case DebuggerX80.REG_PSW:
                cch = 4;
                break;
            }
        }
        return cch? Str.toHex(n, cch) : "??";
    }

    /**
     * getRegValue(iReg)
     *
     * @this {DebuggerX80}
     * @param {number} iReg
     * @return {number|undefined}
     */
    getRegValue(iReg)
    {
        var n;
        if (iReg >= 0) {
            var cpu = this.cpu;
            switch(iReg) {
            case DebuggerX80.REG_A:
                n = cpu.regA;
                break;
            case DebuggerX80.REG_B:
                n = cpu.regB;
                break;
            case DebuggerX80.REG_C:
                n = cpu.regC;
                break;
            case DebuggerX80.REG_BC:
                n = cpu.getBC();
                break;
            case DebuggerX80.REG_D:
                n = cpu.regD;
                break;
            case DebuggerX80.REG_E:
                n = cpu.regE;
                break;
            case DebuggerX80.REG_DE:
                n = cpu.getDE();
                break;
            case DebuggerX80.REG_H:
                n = cpu.regH;
                break;
            case DebuggerX80.REG_L:
                n = cpu.regL;
                break;
            case DebuggerX80.REG_HL:
                n = cpu.getHL();
                break;
            case DebuggerX80.REG_M:
                n = cpu.getByte(cpu.getHL());
                break;
            case DebuggerX80.REG_SP:
                n = cpu.getSP();
                break;
            case DebuggerX80.REG_PC:
                n = cpu.getPC();
                break;
            case DebuggerX80.REG_PS:
                n = cpu.getPS();
                break;
            case DebuggerX80.REG_PSW:
                n = cpu.getPSW();
                break;
            default:
                break;
            }
        }
        return n;
    }

    /**
     * replaceRegs(s)
     *
     * @this {DebuggerX80}
     * @param {string} s
     * @return {string}
     */
    replaceRegs(s)
    {
        /*
         * Replace any references first; this means that register references inside the reference
         * do NOT need to be prefixed with '@'.
         */
        s = this.parseReference(s) || s;

        /*
         * Replace every @XX (or @XXX), where XX (or XXX) is a register, with the register's value.
         */
        var i = 0;
        var b, sChar, sAddr, dbgAddr, sReplace;
        while ((i = s.indexOf('@', i)) >= 0) {
            var iReg = this.getRegIndex(s, i + 1);
            if (iReg >= 0) {
                s = s.substr(0, i) + this.getRegString(iReg) + s.substr(i + 1 + DebuggerX80.REGS[iReg].length);
            }
            i++;
        }
        /*
         * Replace every #XX, where XX is a hex byte value, with the corresponding ASCII character (if printable).
         */
        i = 0;
        while ((i = s.indexOf('#', i)) >= 0) {
            sChar = s.substr(i+1, 2);
            b = Str.parseInt(sChar, 16);
            if (b != null && b >= 32 && b < 127) {
                sReplace = sChar + " '" + String.fromCharCode(b) + "'";
                s = s.replace('#' + sChar, sReplace);
                i += sReplace.length;
                continue;
            }
            i++;
        }
        /*
         * Replace every $XXXX:XXXX, where XXXX:XXXX is a segmented address, with the zero-terminated string at that address.
         */
        i = 0;
        while ((i = s.indexOf('$', i)) >= 0) {
            sAddr = s.substr(i+1, 9);
            dbgAddr = this.parseAddr(sAddr);
            if (dbgAddr) {
                sReplace = sAddr + ' "' + this.getSZ(dbgAddr) + '"';
                s = s.replace('$' + sAddr, sReplace);
                i += sReplace.length;
                continue;
            }
            i++;
        }
        /*
         * Replace every ^XXXX:XXXX, where XXXX:XXXX is a segmented address, with the FCB filename stored at that address.
         */
        i = 0;
        while ((i = s.indexOf('^', i)) >= 0) {
            sAddr = s.substr(i+1, 9);
            dbgAddr = this.parseAddr(sAddr);
            if (dbgAddr) {
                this.incAddr(dbgAddr);
                sReplace = sAddr + ' "' + this.getSZ(dbgAddr, 11) + '"';
                s = s.replace('^' + sAddr, sReplace);
                i += sReplace.length;
                continue;
            }
            i++;
        }
        return s;
    }

    /**
     * message(sMessage, fAddress)
     *
     * @this {DebuggerX80}
     * @param {string} sMessage is any caller-defined message string
     * @param {boolean} [fAddress] is true to display the current CS:IP
     */
    message(sMessage, fAddress)
    {
        if (fAddress) {
            sMessage += " at " + this.toHexAddr(this.newAddr(this.cpu.getPC()));
        }

        if (this.bitsMessage & MessagesX80.BUFFER) {
            this.aMessageBuffer.push(sMessage);
            return;
        }

        if (this.sMessagePrev && sMessage == this.sMessagePrev) return;
        this.sMessagePrev = sMessage;

        if (this.bitsMessage & MessagesX80.HALT) {
            this.stopCPU();
            sMessage += " (cpu halted)";
        }

        this.println(sMessage); // + " (" + this.cpu.getCycles() + " cycles)"

        /*
         * We have no idea what the frequency of println() calls might be; all we know is that they easily
         * screw up the CPU's careful assumptions about cycles per burst.  So we call yieldCPU() after every
         * message, to effectively end the current burst and start fresh.
         *
         * TODO: See CPUx80.calcStartTime() for a discussion of why we might want to call yieldCPU() *before*
         * we display the message.
         */
        if (this.cpu) this.cpu.yieldCPU();
    }

    /**
     * messageIO(component, port, bOut, addrFrom, name, bIn, bitsMessage)
     *
     * Most (if not all) port handlers should provide a name for their respective ports, so if no name is provided,
     * we assume this is an unknown port, and display a message by default.
     *
     * @this {DebuggerX80}
     * @param {Component} component
     * @param {number} port
     * @param {number|null} bOut if an output operation
     * @param {number|null} [addrFrom]
     * @param {string|null} [name] of the port, if any
     * @param {number|null} [bIn] is the input value, if known, on an input operation
     * @param {number} [bitsMessage] is one or more Messages category flag(s)
     */
    messageIO(component, port, bOut, addrFrom, name, bIn, bitsMessage)
    {
        bitsMessage |= MessagesX80.PORT;
        if (name == null || (this.bitsMessage & bitsMessage) == bitsMessage) {
            this.message(component.idComponent + '.' + (bOut != null? "outPort" : "inPort") + '(' + Str.toHexWord(port) + ',' + (name? name : "unknown") + (bOut != null? ',' + Str.toHexByte(bOut) : "") + ')' + (bIn != null? (": " + Str.toHexByte(bIn)) : "") + (addrFrom != null? (" at " + this.toHexOffset(addrFrom)) : ""));
        }
    }

    /**
     * init()
     *
     * @this {DebuggerX80}
     */
    init()
    {
        this.println("Type ? for help with PCx80 Debugger commands");
        this.updateStatus();
        if (this.sInitCommands) {
            var sCmds = this.sInitCommands;
            this.sInitCommands = null;
            this.doCommands(sCmds);
        }
    }

    /**
     * historyInit(fQuiet)
     *
     * This function is intended to be called by the constructor, reset(), addBreakpoint(), findBreakpoint()
     * and any other function that changes the checksEnabled() criteria used to decide whether checkInstruction()
     * should be called.
     *
     * That is, if the history arrays need to be allocated and haven't already been allocated, then allocate them,
     * and if the arrays are no longer needed, then deallocate them.
     *
     * @this {DebuggerX80}
     * @param {boolean} [fQuiet]
     */
    historyInit(fQuiet)
    {
        var i;
        if (!this.checksEnabled()) {
            if (this.aOpcodeHistory && this.aOpcodeHistory.length && !fQuiet) {
                this.println("instruction history buffer freed");
            }
            this.iOpcodeHistory = 0;
            this.aOpcodeHistory = [];
            this.aaOpcodeCounts = [];
            return;
        }
        if (!this.aOpcodeHistory || !this.aOpcodeHistory.length) {
            this.aOpcodeHistory = new Array(DebuggerX80.HISTORY_LIMIT);
            for (i = 0; i < this.aOpcodeHistory.length; i++) {
                /*
                 * Preallocate dummy Addr (Array) objects in every history slot, so that
                 * checkInstruction() doesn't need to call newAddr() on every slot update.
                 */
                this.aOpcodeHistory[i] = this.newAddr();
            }
            this.iOpcodeHistory = 0;
            if (!fQuiet) {
                this.println("instruction history buffer allocated");
            }
        }
        if (!this.aaOpcodeCounts || !this.aaOpcodeCounts.length) {
            this.aaOpcodeCounts = new Array(256);
            for (i = 0; i < this.aaOpcodeCounts.length; i++) {
                this.aaOpcodeCounts[i] = [i, 0];
            }
        }
    }

    /**
     * runCPU(fUpdateFocus)
     *
     * @this {DebuggerX80}
     * @param {boolean} [fUpdateFocus] is true to update focus
     * @return {boolean} true if run request successful, false if not
     */
    runCPU(fUpdateFocus)
    {
        if (!this.isCPUAvail()) return false;
        this.cpu.runCPU(fUpdateFocus);
        return true;
    }

    /**
     * stepCPU(nCycles, fRegs, fUpdateCPU)
     *
     * @this {DebuggerX80}
     * @param {number} nCycles (0 for one instruction without checking breakpoints)
     * @param {boolean} [fRegs] is true to display registers after step (default is false)
     * @param {boolean} [fUpdateCPU] is false to disable calls to updateCPU() (default is true)
     * @return {boolean}
     */
    stepCPU(nCycles, fRegs, fUpdateCPU)
    {
        if (!this.isCPUAvail()) return false;

        this.nCycles = 0;

        if (!nCycles) {
            /*
             * When single-stepping, the CPU won't call checkInstruction(), which is good for
             * avoiding breakpoints, but bad for instruction data collection if checks are enabled.
             * So we call checkInstruction() ourselves.
             */
            if (this.checksEnabled()) this.checkInstruction(this.cpu.getPC(), 0);
        }
        try {
            var nCyclesStep = this.cpu.stepCPU(nCycles);
            if (nCyclesStep > 0) {
                this.nCycles += nCyclesStep;
                this.cpu.addCycles(nCyclesStep, true);
                this.cpu.updateChecksum(nCyclesStep);
                this.cOpcodes++;
            }
        }
        catch(exception) {
            if (typeof exception != "number") {
                var e = exception;
                this.nCycles = 0;
                this.cpu.setError(e.stack || e.message);
            }
        }

        /*
         * Because we called cpu.stepCPU() and not cpu.runCPU(), we must nudge the cpu's update code,
         * and then update our own state.  Normally, the only time fUpdateCPU will be false is when doTrace()
         * is calling us in a loop, in which case it will perform its own updateCPU() when it's done.
         */
        if (fUpdateCPU !== false) this.cpu.updateCPU();

        this.updateStatus(fRegs || false);
        return (this.nCycles > 0);
    }

    /**
     * stopCPU()
     *
     * @this {DebuggerX80}
     * @param {boolean} [fComplete]
     */
    stopCPU(fComplete)
    {
        if (this.cpu) this.cpu.stopCPU(fComplete);
    }

    /**
     * updateStatus(fRegs)
     *
     * @this {DebuggerX80}
     * @param {boolean} [fRegs] (default is true)
     */
    updateStatus(fRegs)
    {
        if (fRegs === undefined) fRegs = true;

        this.dbgAddrNextCode = this.newAddr(this.cpu.getPC());
        /*
         * this.nStep used to be a simple boolean, but now it's 0 (or undefined)
         * if inactive, 1 if stepping over an instruction without a register dump, or 2
         * if stepping over an instruction with a register dump.
         */
        if (!fRegs || this.nStep == 1)
            this.doUnassemble();
        else {
            this.doRegisters();
        }
    }

    /**
     * isCPUAvail()
     *
     * Make sure the CPU is ready (finished initializing), not busy (already running), and not in an error state.
     *
     * @this {DebuggerX80}
     * @return {boolean}
     */
    isCPUAvail()
    {
        if (!this.cpu)
            return false;
        if (!this.cpu.isReady())
            return false;
        if (!this.cpu.isPowered())
            return false;
        if (this.cpu.isBusy())
            return false;
        return !this.cpu.isError();
    }

    /**
     * powerUp(data, fRepower)
     *
     * @this {DebuggerX80}
     * @param {Object|null} data
     * @param {boolean} [fRepower]
     * @return {boolean} true if successful, false if failure
     */
    powerUp(data, fRepower)
    {
        if (!fRepower) {
            /*
             * Because Debugger save/restore support is somewhat limited (and didn't always exist),
             * we deviate from the typical save/restore design pattern: instead of reset OR restore,
             * we always reset and then perform a (potentially limited) restore.
             */
            this.reset(true);

            // this.println(data? "resuming" : "powering up");

            if (data && this.restore) {
                if (!this.restore(data)) return false;
            }
        }
        return true;
    }

    /**
     * powerDown(fSave, fShutdown)
     *
     * @this {DebuggerX80}
     * @param {boolean} [fSave]
     * @param {boolean} [fShutdown]
     * @return {Object|boolean}
     */
    powerDown(fSave, fShutdown)
    {
        if (fShutdown) this.println(fSave? "suspending" : "shutting down");
        return fSave? this.save() : true;
    }

    /**
     * reset(fQuiet)
     *
     * This is a notification handler, called by the Computer, to inform us of a reset.
     *
     * @this {DebuggerX80}
     * @param {boolean} fQuiet (true only when called from our own powerUp handler)
     */
    reset(fQuiet)
    {
        this.historyInit();
        this.cOpcodes = this.cOpcodesStart = 0;
        this.sMessagePrev = null;
        this.nCycles = 0;
        this.dbgAddrNextCode = this.newAddr(this.cpu.getPC());
        /*
         * fRunning is set by start() and cleared by stop().  In addition, we clear
         * it here, so that if the CPU is reset while running, we can prevent stop()
         * from unnecessarily dumping the CPU state.
         */
        this.flags.running = false;
        this.clearTempBreakpoint();
        if (!fQuiet) this.updateStatus();
    }

    /**
     * save()
     *
     * This implements (very rudimentary) save support for the Debugger component.
     *
     * @this {DebuggerX80}
     * @return {Object}
     */
    save()
    {
        var state = new State(this);
        state.set(0, this.packAddr(this.dbgAddrNextCode));
        state.set(1, this.packAddr(this.dbgAddrAssemble));
        state.set(2, [this.aPrevCmds, this.fAssemble, this.bitsMessage]);
        state.set(3, this.aSymbolTable);
        return state.data();
    }

    /**
     * restore(data)
     *
     * This implements (very rudimentary) restore support for the Debugger component.
     *
     * @this {DebuggerX80}
     * @param {Object} data
     * @return {boolean} true if successful, false if failure
     */
    restore(data)
    {
        var i = 0;
        if (data[2] !== undefined) {
            this.dbgAddrNextCode = this.unpackAddr(data[i++]);
            this.dbgAddrAssemble = this.unpackAddr(data[i++]);
            this.aPrevCmds = data[i][0];
            if (typeof this.aPrevCmds == "string") this.aPrevCmds = [this.aPrevCmds];
            this.fAssemble = data[i][1];
            this.bitsMessage |= data[i][2];     // keep our current message bits set, and simply "add" any extra bits defined by the saved state
        }
        if (data[3]) this.aSymbolTable = data[3];
        return true;
    }

    /**
     * start(ms, nCycles)
     *
     * This is a notification handler, called by the Computer, to inform us the CPU has started.
     *
     * @this {DebuggerX80}
     * @param {number} ms
     * @param {number} nCycles
     */
    start(ms, nCycles)
    {
        if (!this.nStep) this.println("running");
        this.flags.running = true;
        this.msStart = ms;
        this.nCyclesStart = nCycles;
    }

    /**
     * stop(ms, nCycles)
     *
     * This is a notification handler, called by the Computer, to inform us the CPU has now stopped.
     *
     * @this {DebuggerX80}
     * @param {number} ms
     * @param {number} nCycles
     */
    stop(ms, nCycles)
    {
        if (this.flags.running) {
            this.flags.running = false;
            this.nCycles = nCycles - this.nCyclesStart;
            if (!this.nStep) {
                var sStopped = "stopped";
                if (this.nCycles) {
                    var msTotal = ms - this.msStart;
                    var nCyclesPerSecond = (msTotal > 0? Math.round(this.nCycles * 1000 / msTotal) : 0);
                    sStopped += " (";
                    if (this.checksEnabled()) {
                        sStopped += this.cOpcodes + " opcodes, ";
                        /*
                         * $ops displays progress by calculating cOpcodes - cOpcodesStart, so before
                         * zeroing cOpcodes, we should subtract cOpcodes from cOpcodesStart (since we're
                         * effectively subtracting cOpcodes from cOpcodes as well).
                         */
                        this.cOpcodesStart -= this.cOpcodes;
                        this.cOpcodes = 0;
                    }
                    sStopped += this.nCycles + " cycles, " + msTotal + " ms, " + nCyclesPerSecond + " hz)";
                } else {
                    if (this.messageEnabled(MessagesX80.HALT)) {
                        /*
                         * It's possible the user is trying to 'g' past a fault that was blocked by helpCheckFault()
                         * for the Debugger's benefit; if so, it will continue to be blocked, so try displaying a helpful
                         * message (another helpful tip would be to simply turn off the "halt" message category).
                         */
                        sStopped += " (use the 't' command to execute blocked faults)";
                    }
                }
                this.println(sStopped);
            }
            this.updateStatus(true);
            this.updateFocus();
            this.clearTempBreakpoint(this.cpu.getPC());
        }
    }

    /**
     * checksEnabled(fRelease)
     *
     * This "check" function is called by the CPU; we indicate whether or not every instruction needs to be checked.
     *
     * Originally, this returned true even when there were only read and/or write breakpoints, but those breakpoints
     * no longer require the intervention of checkInstruction(); the Bus component automatically swaps in/out appropriate
     * "checked" Memory access functions to deal with those breakpoints in the corresponding Memory blocks.  So I've
     * simplified the test below.
     *
     * @this {DebuggerX80}
     * @param {boolean} [fRelease] is true for release criteria only; default is false (any criteria)
     * @return {boolean} true if every instruction needs to pass through checkInstruction(), false if not
     */
    checksEnabled(fRelease)
    {
        return ((DEBUG && !fRelease)? true : (this.aBreakExec.length > 1 || !!this.nBreakIns));
    }

    /**
     * checkInstruction(addr, nState)
     *
     * This "check" function is called by the CPU to inform us about the next instruction to be executed,
     * giving us an opportunity to look for "exec" breakpoints and update opcode frequencies and instruction history.
     *
     * @this {DebuggerX80}
     * @param {number} addr
     * @param {number} nState is < 0 if stepping, 0 if starting, or > 0 if running
     * @return {boolean} true if breakpoint hit, false if not
     */
    checkInstruction(addr, nState)
    {
        var cpu = this.cpu;

        if (nState > 0) {
            if (this.nBreakIns && !--this.nBreakIns) {
                return true;
            }
            if (this.checkBreakpoint(addr, 1, this.aBreakExec)) {
                return true;
            }
        }

        /*
         * The rest of the instruction tracking logic can only be performed if historyInit() has allocated the
         * necessary data structures.  Note that there is no explicit UI for enabling/disabling history, other than
         * adding/removing breakpoints, simply because it's breakpoints that trigger the call to checkInstruction();
         * well, OK, and a few other things now, like enabling MessagesX80.INT messages.
         */
        if (nState >= 0 && this.aaOpcodeCounts.length) {
            this.cOpcodes++;
            var bOpcode = this.bus.getByteDirect(addr);
            if (bOpcode != null) {
                this.aaOpcodeCounts[bOpcode][1]++;
                var dbgAddr = this.aOpcodeHistory[this.iOpcodeHistory];
                this.setAddr(dbgAddr, cpu.getPC());
                if (DEBUG) dbgAddr.cycleCount = cpu.getCycles();
                if (++this.iOpcodeHistory == this.aOpcodeHistory.length) this.iOpcodeHistory = 0;
            }
        }
        return false;
    }

    /**
     * checkMemoryRead(addr, nb)
     *
     * This "check" function is called by a Memory block to inform us that a memory read occurred, giving us an
     * opportunity to track the read if we want, and look for a matching "read" breakpoint, if any.
     *
     * In the "old days", it would be an error for this call to fail to find a matching Debugger breakpoint, but now
     * Memory blocks have no idea whether the Debugger or the machine's Debug register(s) triggered this "checked" read.
     *
     * If we return true, we "trump" the machine's Debug register(s); false allows normal Debug register processing.
     *
     * @this {DebuggerX80}
     * @param {number} addr
     * @param {number} [nb] (# of bytes; default is 1)
     * @return {boolean} true if breakpoint hit, false if not
     */
    checkMemoryRead(addr, nb)
    {
        if (this.checkBreakpoint(addr, nb || 1, this.aBreakRead)) {
            this.stopCPU(true);
            return true;
        }
        return false;
    }

    /**
     * checkMemoryWrite(addr, nb)
     *
     * This "check" function is called by a Memory block to inform us that a memory write occurred, giving us an
     * opportunity to track the write if we want, and look for a matching "write" breakpoint, if any.
     *
     * In the "old days", it would be an error for this call to fail to find a matching Debugger breakpoint, but now
     * Memory blocks have no idea whether the Debugger or the machine's Debug register(s) triggered this "checked" write.
     *
     * If we return true, we "trump" the machine's Debug register(s); false allows normal Debug register processing.
     *
     * @this {DebuggerX80}
     * @param {number} addr
     * @param {number} [nb] (# of bytes; default is 1)
     * @return {boolean} true if breakpoint hit, false if not
     */
    checkMemoryWrite(addr, nb)
    {
        if (this.checkBreakpoint(addr, nb || 1, this.aBreakWrite)) {
            this.stopCPU(true);
            return true;
        }
        return false;
    }

    /**
     * checkPortInput(port, size, data)
     *
     * This "check" function is called by the Bus component to inform us that port input occurred.
     *
     * @this {DebuggerX80}
     * @param {number} port
     * @param {number} size
     * @param {number} data
     * @return {boolean} true if breakpoint hit, false if not
     */
    checkPortInput(port, size, data)
    {
        /*
         * We trust that the Bus component won't call us unless we told it to, so we halt unconditionally
         */
        this.println("break on input from port " + Str.toHexWord(port) + ": " + Str.toHex(data));
        this.stopCPU(true);
        return true;
    }

    /**
     * checkPortOutput(port, size, data)
     *
     * This "check" function is called by the Bus component to inform us that port output occurred.
     *
     * @this {DebuggerX80}
     * @param {number} port
     * @param {number} size
     * @param {number} data
     * @return {boolean} true if breakpoint hit, false if not
     */
    checkPortOutput(port, size, data)
    {
        /*
         * We trust that the Bus component won't call us unless we told it to, so we halt unconditionally
         */
        this.println("break on output to port " + Str.toHexWord(port) + ": " + Str.toHex(data));
        this.stopCPU(true);
        return true;
    }

    /**
     * clearBreakpoints()
     *
     * @this {DebuggerX80}
     */
    clearBreakpoints()
    {
        var i, dbgAddr;
        this.aBreakExec = ["bp"];
        if (this.aBreakRead !== undefined) {
            for (i = 1; i < this.aBreakRead.length; i++) {
                dbgAddr = this.aBreakRead[i];
                this.bus.removeMemBreak(this.getAddr(dbgAddr), false);
            }
        }
        this.aBreakRead = ["br"];
        if (this.aBreakWrite !== undefined) {
            for (i = 1; i < this.aBreakWrite.length; i++) {
                dbgAddr = this.aBreakWrite[i];
                this.bus.removeMemBreak(this.getAddr(dbgAddr), true);
            }
        }
        this.aBreakWrite = ["bw"];
        /*
         * nSuppressBreaks ensures we can't get into an infinite loop where a breakpoint lookup requires
         * reading a segment descriptor via getSegment(), and that triggers more memory reads, which triggers
         * more breakpoint checks.
         */
        this.nSuppressBreaks = 0;
    }

    /**
     * addBreakpoint(aBreak, dbgAddr, fTemporary)
     *
     * In case you haven't already figured this out, all our breakpoint commands use the address
     * to identify a breakpoint, not an incrementally assigned breakpoint index like other debuggers;
     * see doBreak() for details.
     *
     * This has a few implications, one being that you CANNOT set more than one kind of breakpoint
     * on a single address.  In practice, that's rarely a problem, because you can almost always set
     * a different breakpoint on a neighboring address.
     *
     * Also, there is one exception to the "one address, one breakpoint" rule, and that involves
     * temporary breakpoints (ie, one-time execution breakpoints that either a "p" or "g" command
     * may create to step over a chunk of code).  Those breakpoints automatically clear themselves,
     * so there usually isn't any need to refer to them using breakpoint commands.
     *
     * TODO: Consider supporting the more "traditional" breakpoint index syntax; the current
     * address-based syntax was implemented solely for expediency and consistency.  At the same time,
     * also consider a more WDEB386-like syntax, where "br" is used to set a variety of access-specific
     * breakpoints, using modifiers like "r1", "r2", "w1", "w2, etc.
     *
     * @this {DebuggerX80}
     * @param {Array} aBreak
     * @param {DbgAddrX80} dbgAddr
     * @param {boolean} [fTemporary]
     * @return {boolean} true if breakpoint added, false if already exists
     */
    addBreakpoint(aBreak, dbgAddr, fTemporary)
    {
        var fSuccess = true;

        // this.nSuppressBreaks++;

        /*
         * Instead of complaining that a breakpoint already exists (as we used to do), we now
         * allow breakpoints to be re-set; this makes it easier to update any commands that may
         * be associated with the breakpoint.
         *
         * The only exception: we DO allow a temporary breakpoint at an address where there may
         * already be a breakpoint, so that you can easily step ("p" or "g") over such addresses.
         */
        if (!fTemporary) {
            this.findBreakpoint(aBreak, dbgAddr, true, false, true);
        }

        if (aBreak != this.aBreakExec) {
            var addr = this.getAddr(dbgAddr);
            if (addr === CPUDefX80.ADDR_INVALID) {
                this.println("invalid address: " + this.toHexAddr(dbgAddr));
                fSuccess = false;
            } else {
                this.bus.addMemBreak(addr, aBreak == this.aBreakWrite);
            }
        }

        if (fSuccess) {
            aBreak.push(dbgAddr);
            if (fTemporary) {
                dbgAddr.fTemporary = true;
            }
            else {
                this.printBreakpoint(aBreak, aBreak.length-1, "set");
                this.historyInit();
            }
        }

        // this.nSuppressBreaks--;

        return fSuccess;
    }

    /**
     * findBreakpoint(aBreak, dbgAddr, fRemove, fTemporary, fQuiet)
     *
     * @this {DebuggerX80}
     * @param {Array} aBreak
     * @param {DbgAddrX80} dbgAddr
     * @param {boolean} [fRemove]
     * @param {boolean} [fTemporary]
     * @param {boolean} [fQuiet]
     * @return {boolean} true if found, false if not
     */
    findBreakpoint(aBreak, dbgAddr, fRemove, fTemporary, fQuiet)
    {
        var fFound = false;
        var addr = this.getAddr(dbgAddr);
        for (var i = 1; i < aBreak.length; i++) {
            var dbgAddrBreak = aBreak[i];
            if (addr == this.getAddr(dbgAddrBreak)) {
                if (!fTemporary || dbgAddrBreak.fTemporary) {
                    fFound = true;
                    if (fRemove) {
                        if (!dbgAddrBreak.fTemporary && !fQuiet) {
                            this.printBreakpoint(aBreak, i, "cleared");
                        }
                        aBreak.splice(i, 1);
                        if (aBreak != this.aBreakExec) {
                            this.bus.removeMemBreak(addr, aBreak == this.aBreakWrite);
                        }
                        /*
                         * We'll mirror the logic in addBreakpoint() and leave the history buffer alone if this
                         * was a temporary breakpoint.
                         */
                        if (!dbgAddrBreak.fTemporary) {
                            this.historyInit();
                        }
                        break;
                    }
                    if (!fQuiet) this.printBreakpoint(aBreak, i, "exists");
                    break;
                }
            }
        }
        return fFound;
    }

    /**
     * listBreakpoints(aBreak)
     *
     * @this {DebuggerX80}
     * @param {Array} aBreak
     * @return {number} of breakpoints listed, 0 if none
     */
    listBreakpoints(aBreak)
    {
        for (var i = 1; i < aBreak.length; i++) {
            this.printBreakpoint(aBreak, i);
        }
        return aBreak.length - 1;
    }

    /**
     * printBreakpoint(aBreak, i, sAction)
     *
     * @this {DebuggerX80}
     * @param {Array} aBreak
     * @param {number} i
     * @param {string} [sAction]
     */
    printBreakpoint(aBreak, i, sAction)
    {
        var dbgAddr = aBreak[i];
        this.println(aBreak[0] + ' ' + this.toHexAddr(dbgAddr) + (sAction? (' ' + sAction) : (dbgAddr.sCmd? (' "' + dbgAddr.sCmd + '"') : '')));
    }

    /**
     * setTempBreakpoint(dbgAddr)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr of new temp breakpoint
     */
    setTempBreakpoint(dbgAddr)
    {
        this.addBreakpoint(this.aBreakExec, dbgAddr, true);
    }

    /**
     * clearTempBreakpoint(addr)
     *
     * @this {DebuggerX80}
     * @param {number|undefined} [addr] clear all temp breakpoints if no address specified
     */
    clearTempBreakpoint(addr)
    {
        if (addr !== undefined) {
            this.checkBreakpoint(addr, 1, this.aBreakExec, true);
            this.nStep = 0;
        } else {
            for (var i = 1; i < this.aBreakExec.length; i++) {
                var dbgAddrBreak = this.aBreakExec[i];
                if (dbgAddrBreak.fTemporary) {
                    if (!this.findBreakpoint(this.aBreakExec, dbgAddrBreak, true, true)) break;
                    i = 0;
                }
            }
        }
    }

    /**
     * checkBreakpoint(addr, nb, aBreak, fTemporary)
     *
     * @this {DebuggerX80}
     * @param {number} addr
     * @param {number} nb (# of bytes)
     * @param {Array} aBreak
     * @param {boolean} [fTemporary]
     * @return {boolean} true if breakpoint has been hit, false if not
     */
    checkBreakpoint(addr, nb, aBreak, fTemporary)
    {
        /*
         * Time to check for execution breakpoints; note that this should be done BEFORE updating frequency
         * or history data (see checkInstruction), since we might not actually execute the current instruction.
         */
        var fBreak = false;

        if (!this.nSuppressBreaks++) {

            for (var i = 1; !fBreak && i < aBreak.length; i++) {

                var dbgAddrBreak = aBreak[i];

                if (fTemporary && !dbgAddrBreak.fTemporary) continue;

                /*
                 * We used to calculate the linear address of the breakpoint at the time the
                 * breakpoint was added, so that a breakpoint set in one mode (eg, in real-mode)
                 * would still work as intended if the mode changed later (eg, to protected-mode).
                 *
                 * However, that created difficulties setting protected-mode breakpoints in segments
                 * that might not be defined yet, or that could move in physical memory.
                 *
                 * If you want to create a real-mode breakpoint that will break regardless of mode,
                 * use the physical address of the real-mode memory location instead.
                 */
                var addrBreak = this.getAddr(dbgAddrBreak);
                for (var n = 0; n < nb; n++) {
                    if (addr + n == addrBreak) {
                        var a;
                        fBreak = true;
                        if (dbgAddrBreak.fTemporary) {
                            this.findBreakpoint(aBreak, dbgAddrBreak, true, true);
                            fTemporary = true;
                        }
                        if ((a = dbgAddrBreak.aCmds)) {
                            /*
                             * When one or more commands are attached to a breakpoint, we don't halt by default.
                             * Instead, we set fBreak to true only if, at the completion of all the commands, the
                             * CPU is halted; in other words, you should include "h" as one of the breakpoint commands
                             * if you want the breakpoint to stop execution.
                             *
                             * Another useful command is "if", which will return false if the expression is false,
                             * at which point we'll jump ahead to the next "else" command, and if there isn't an "else",
                             * we abort.
                             */
                            fBreak = false;
                            for (var j = 0; j < a.length; j++) {
                                if (!this.doCommand(a[j], true)) {
                                    if (a[j].indexOf("if")) {
                                        fBreak = true;          // the failed command wasn't "if", so abort
                                        break;
                                    }
                                    var k = j + 1;
                                    for (; k < a.length; k++) {
                                        if (!a[k].indexOf("else")) break;
                                        j++;
                                    }
                                    if (k == a.length) {        // couldn't find an "else" after the "if", so abort
                                        fBreak = true;
                                        break;
                                    }
                                    /*
                                     * If we're still here, we'll execute the "else" command (which is just a no-op),
                                     * followed by any remaining commands.
                                     */
                                }
                            }
                            if (!this.cpu.isRunning()) fBreak = true;
                        }
                        if (fBreak) {
                            if (!fTemporary) this.printBreakpoint(aBreak, i, "hit");
                            break;
                        }
                    }
                }
            }
        }

        this.nSuppressBreaks--;

        return fBreak;
    }

    /**
     * getInstruction(dbgAddr, sComment, nSequence)
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {string} [sComment] is an associated comment
     * @param {number|null} [nSequence] is an associated sequence number, undefined if none
     * @return {string} (and dbgAddr is updated to the next instruction)
     */
    getInstruction(dbgAddr, sComment, nSequence)
    {
        var dbgAddrIns = this.newAddr(dbgAddr.addr);

        var bOpcode = this.getByte(dbgAddr, 1);

        var asOpcodes = this.style != DebuggerX80.STYLE_8086? DebuggerX80.INS_NAMES : DebuggerX80.INS_NAMES_8086;
        var aOpDesc = this.aaOpDescs[bOpcode];
        var iIns = aOpDesc[0];

        var sOperands = "";
        var sOpcode = asOpcodes[iIns];
        var cOperands = aOpDesc.length - 1;
        var typeSizeDefault = DebuggerX80.TYPE_NONE, type;

        for (var iOperand = 1; iOperand <= cOperands; iOperand++) {

            var disp, off, cch;
            var sOperand = "";

            type = aOpDesc[iOperand];
            if (type === undefined) continue;
            if ((type & DebuggerX80.TYPE_OPT) && this.style == DebuggerX80.STYLE_8080) continue;

            var typeMode = type & DebuggerX80.TYPE_MODE;
            if (!typeMode) continue;

            var typeSize = type & DebuggerX80.TYPE_SIZE;
            if (!typeSize) {
                type |= typeSizeDefault;
            } else {
                typeSizeDefault = typeSize;
            }

            var typeOther = type & DebuggerX80.TYPE_OTHER;
            if (!typeOther) {
                type |= (iOperand == 1? DebuggerX80.TYPE_OUT : DebuggerX80.TYPE_IN);
            }

            if (typeMode & DebuggerX80.TYPE_IMM) {
                sOperand = this.getImmOperand(type, dbgAddr);
            }
            else if (typeMode & DebuggerX80.TYPE_REG) {
                sOperand = this.getRegOperand((type & DebuggerX80.TYPE_IREG) >> 8, type, dbgAddr);
            }
            else if (typeMode & DebuggerX80.TYPE_INT) {
                sOperand = ((bOpcode >> 3) & 0x7).toString();
            }

            if (!sOperand || !sOperand.length) {
                sOperands = "INVALID";
                break;
            }
            if (sOperands.length > 0) sOperands += ',';
            sOperands += (sOperand || "???");
        }

        var sBytes = "";
        var sLine = this.toHexAddr(dbgAddrIns) + ' ';
        if (dbgAddrIns.addr !== CPUDefX80.ADDR_INVALID && dbgAddr.addr !== CPUDefX80.ADDR_INVALID) {
            do {
                sBytes += Str.toHex(this.getByte(dbgAddrIns, 1), 2);
                if (dbgAddrIns.addr == null) break;
            } while (dbgAddrIns.addr != dbgAddr.addr);
        }

        sLine += Str.pad(sBytes, 10);
        sLine += (type & DebuggerX80.TYPE_UNDOC)? '*' : ' ';
        sLine += Str.pad(sOpcode, 7);
        if (sOperands) sLine += ' ' + sOperands;

        if (sComment) {
            sLine = Str.pad(sLine, 40) + ';' + sComment;
            if (!this.cpu.flags.checksum) {
                sLine += (nSequence != null? '=' + nSequence.toString() : "");
            } else {
                var nCycles = this.cpu.getCycles();
                sLine += "cycles=" + nCycles.toString() + " cs=" + Str.toHex(this.cpu.nChecksum);
            }
        }
        return sLine;
    }

    /**
     * getImmOperand(type, dbgAddr)
     *
     * @this {DebuggerX80}
     * @param {number} type
     * @param {DbgAddrX80} dbgAddr
     * @return {string} operand
     */
    getImmOperand(type, dbgAddr)
    {
        var sOperand = ' ';
        var typeSize = type & DebuggerX80.TYPE_SIZE;

        switch (typeSize) {
        case DebuggerX80.TYPE_BYTE:
            sOperand = Str.toHex(this.getByte(dbgAddr, 1), 2);
            break;
        case DebuggerX80.TYPE_SBYTE:
            sOperand = Str.toHex((this.getByte(dbgAddr, 1) << 24) >> 24, 4);
            break;
        case DebuggerX80.TYPE_WORD:
            sOperand = Str.toHex(this.getShort(dbgAddr, 2), 4);
            break;
        default:
            return "imm(" + Str.toHexWord(type) + ')';
        }
        if (this.style == DebuggerX80.STYLE_8086 && (type & DebuggerX80.TYPE_MEM)) {
            sOperand = '[' + sOperand + ']';
        } else if (!(type & DebuggerX80.TYPE_REG)) {
            sOperand = (this.style == DebuggerX80.STYLE_8080? '$' : "0x") + sOperand;
        }
        return sOperand;
    }

    /**
     * getRegOperand(iReg, type, dbgAddr)
     *
     * @this {DebuggerX80}
     * @param {number} iReg
     * @param {number} type
     * @param {DbgAddrX80} dbgAddr
     * @return {string} operand
     */
    getRegOperand(iReg, type, dbgAddr)
    {
        /*
         * Although this breaks with 8080 assembler conventions, I'm going to experiment with some different
         * mnemonics; specifically, "[HL]" instead of "M".  This is also more in keeping with how getImmOperand()
         * displays memory references (ie, by enclosing them in brackets).
         */
        var sOperand = DebuggerX80.REGS[iReg];
        if (this.style == DebuggerX80.STYLE_8086 && (type & DebuggerX80.TYPE_MEM)) {
            if (iReg == DebuggerX80.REG_M) {
                sOperand = "HL";
            }
            sOperand = '[' + sOperand + ']';
        }
        return sOperand;
    }

    /**
     * parseInstruction(sOp, sOperand, addr)
     *
     * TODO: Unimplemented.  See parseInstruction() in modules/c1pjs/lib/debugger.js for a working implementation.
     *
     * @this {DebuggerX80}
     * @param {string} sOp
     * @param {string|undefined} sOperand
     * @param {DbgAddrX80} dbgAddr of memory where this instruction is being assembled
     * @return {Array.<number>} of opcode bytes; if the instruction can't be parsed, the array will be empty
     */
    parseInstruction(sOp, sOperand, dbgAddr)
    {
        var aOpBytes = [];
        this.println("not supported yet");
        return aOpBytes;
    }

    /**
     * getFlagOutput(sFlag)
     *
     * @this {DebuggerX80}
     * @param {string} sFlag
     * @return {string} value of flag
     */
    getFlagOutput(sFlag)
    {
        var b;
        switch (sFlag) {
        case "IF":
            b = this.cpu.getIF();
            break;
        case "SF":
            b = this.cpu.getSF();
            break;
        case "ZF":
            b = this.cpu.getZF();
            break;
        case "AF":
            b = this.cpu.getAF();
            break;
        case "PF":
            b = this.cpu.getPF();
            break;
        case "CF":
            b = this.cpu.getCF();
            break;
        default:
            b = 0;
            break;
        }
        return sFlag.charAt(0) + (b? '1' : '0') + ' ';
    }

    /**
     * getRegOutput(iReg)
     *
     * @this {DebuggerX80}
     * @param {number} iReg
     * @return {string}
     */
    getRegOutput(iReg)
    {
        var sReg = DebuggerX80.REGS[iReg];
        return sReg + '=' + this.getRegString(iReg) + ' ';
    }

    /**
     * getRegDump()
     *
     * Sample 8080 register dump:
     *
     *      A=00 BC=0000 DE=0000 HL=0000 SP=0000 I0 S0 Z0 A0 P0 C0
     *      0000 00         NOP
     *
     * @this {DebuggerX80}
     * @return {string}
     */
    getRegDump()
    {
        var s;
        s = this.getRegOutput(DebuggerX80.REG_A) +
            this.getRegOutput(DebuggerX80.REG_BC) +
            this.getRegOutput(DebuggerX80.REG_DE) +
            this.getRegOutput(DebuggerX80.REG_HL) +
            this.getRegOutput(DebuggerX80.REG_SP) +
            this.getFlagOutput("IF") + this.getFlagOutput("SF") + this.getFlagOutput("ZF") +
            this.getFlagOutput("AF") + this.getFlagOutput("PF") + this.getFlagOutput("CF");
        return s;
    }

    /**
     * comparePairs(p1, p2)
     *
     * @this {DebuggerX80}
     * @param {number|string|Array|Object} p1
     * @param {number|string|Array|Object} p2
     * @return {number}
     */
    comparePairs(p1, p2)
    {
        return p1[0] > p2[0]? 1 : p1[0] < p2[0]? -1 : 0;
    }

    /**
     * addSymbols(sModule, addr, len, aSymbols)
     *
     * As filedump.js (formerly convrom.php) explains, aSymbols is a JSON-encoded object whose properties consist
     * of all the symbols (in upper-case), and the values of those properties are objects containing any or all of
     * the following properties:
     *
     *      'v': the value of an absolute (unsized) value
     *      'b': either 1, 2, 4 or undefined if an unsized value
     *      's': either a hard-coded segment or undefined
     *      'o': the offset of the symbol within the associated address space
     *      'l': the original-case version of the symbol, present only if it wasn't originally upper-case
     *      'a': annotation for the specified offset; eg, the original assembly language, with optional comment
     *
     * To that list of properties, we also add:
     *
     *      'p': the physical address (calculated whenever both 's' and 'o' properties are defined)
     *
     * Note that values for any 'v', 'b', 's' and 'o' properties are unquoted decimal values, and the values
     * for any 'l' or 'a' properties are quoted strings. Also, if double-quotes were used in any of the original
     * annotation ('a') values, they will have been converted to two single-quotes, so we're responsible for
     * converting them back to individual double-quotes.
     *
     * For example:
     *      {
     *          'HF_PORT': {
     *              'v':800
     *          },
     *          'HDISK_INT': {
     *              'b':4, 's':0, 'o':52
     *          },
     *          'ORG_VECTOR': {
     *              'b':4, 's':0, 'o':76
     *          },
     *          'CMD_BLOCK': {
     *              'b':1, 's':64, 'o':66
     *          },
     *          'DISK_SETUP': {
     *              'o':3
     *          },
     *          '.40': {
     *              'o':40, 'a':"MOV AX,WORD PTR ORG_VECTOR ;GET DISKETTE VECTOR"
     *          }
     *      }
     *
     * If a symbol only has an offset, then that offset value can be assigned to the symbol property directly:
     *
     *          'DISK_SETUP': 3
     *
     * The last property is an example of an "anonymous" entry, for offsets where there is no associated symbol.
     * Such entries are identified by a period followed by a unique number (usually the offset of the entry), and
     * they usually only contain offset ('o') and annotation ('a') properties.  I could eliminate the leading
     * period, but it offers a very convenient way of quickly discriminating among genuine vs. anonymous symbols.
     *
     * We add all these entries to our internal symbol table, which is an array of 4-element arrays, each of which
     * look like:
     *
     *      [addr, len, aSymbols, aOffsets]
     *
     * There are two basic symbol operations: findSymbol(), which takes an address and finds the symbol, if any,
     * at that address, and findSymbolAddr(), which takes a string and attempts to match it to a non-anonymous
     * symbol with a matching offset ('o') property.
     *
     * To implement findSymbol() efficiently, addSymbols() creates an array of [offset, sSymbol] pairs
     * (aOffsets), one pair for each symbol that corresponds to an offset within the specified address space.
     *
     * We guarantee the elements of aOffsets are in offset order, because we build it using binaryInsert();
     * it's quite likely that the MAP file already ordered all its symbols in offset order, but since they're
     * hand-edited files, we can't assume that, and we need to ensure that findSymbol()'s binarySearch() operates
     * properly.
     *
     * @this {DebuggerX80}
     * @param {string|null} sModule
     * @param {number|null} addr (physical address where the symbols are located, if the memory is physical; eg, ROM)
     * @param {number} len (the size of the region, in bytes)
     * @param {Object} aSymbols (collection of symbols in this group; the format of this collection is described below)
     */
    addSymbols(sModule, addr, len, aSymbols)
    {
        var dbgAddr = {};
        var aOffsets = [];
        for (var sSymbol in aSymbols) {
            var symbol = aSymbols[sSymbol];
            if (typeof symbol == "number") {
                aSymbols[sSymbol] = symbol = {'o': symbol};
            }
            var offSymbol = symbol['o'];
            var sAnnotation = symbol['a'];
            if (offSymbol !== undefined) {
                Usr.binaryInsert(aOffsets, [offSymbol >>> 0, sSymbol], this.comparePairs);
            }
            if (sAnnotation) symbol['a'] = sAnnotation.replace(/''/g, "\"");
        }
        var symbolTable = {
            sModule: sModule,
            addr: addr,
            len: len,
            aSymbols: aSymbols,
            aOffsets: aOffsets
        };
        this.aSymbolTable.push(symbolTable);
    }

    /**
     * dumpSymbols()
     *
     * TODO: Add "numerical" and "alphabetical" dump options. This is simply dumping them in whatever
     * order they appeared in the original MAP file.
     *
     * @this {DebuggerX80}
     */
    dumpSymbols()
    {
        for (var iTable = 0; iTable < this.aSymbolTable.length; iTable++) {
            var symbolTable = this.aSymbolTable[iTable];
            for (var sSymbol in symbolTable.aSymbols) {
                if (sSymbol.charAt(0) == '.') continue;
                var symbol = symbolTable.aSymbols[sSymbol];
                var offSymbol = symbol['o'];
                if (offSymbol === undefined) continue;
                var sSymbolOrig = symbolTable.aSymbols[sSymbol]['l'];
                if (sSymbolOrig) sSymbol = sSymbolOrig;
                this.println(this.toHexOffset(offSymbol) + ' ' + sSymbol);
            }
        }
    }

    /**
     * findSymbol(dbgAddr, fNearest)
     *
     * Search aSymbolTable for dbgAddr, and return an Array for the corresponding symbol (empty if not found).
     *
     * If fNearest is true, and no exact match was found, then the Array returned will contain TWO sets of
     * entries: [0]-[3] will refer to closest preceding symbol, and [4]-[7] will refer to the closest subsequent symbol.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @param {boolean} [fNearest]
     * @return {Array} where [0] == symbol name, [1] == symbol value, [2] == any annotation, and [3] == any associated comment
     */
    findSymbol(dbgAddr, fNearest)
    {
        var aSymbol = [];
        var addrSymbol = this.getAddr(dbgAddr) >>> 0;
        for (var iTable = 0; iTable < this.aSymbolTable.length; iTable++) {
            var symbolTable = this.aSymbolTable[iTable];
            var addr = symbolTable.addr >>> 0;
            var len = symbolTable.len;
            if (addrSymbol >= addr && addrSymbol < addr + len) {
                var offSymbol = addrSymbol - addr;
                var result = Usr.binarySearch(symbolTable.aOffsets, [offSymbol], this.comparePairs);
                if (result >= 0) {
                    this.returnSymbol(iTable, result, aSymbol);
                }
                else if (fNearest) {
                    result = ~result;
                    this.returnSymbol(iTable, result-1, aSymbol);
                    this.returnSymbol(iTable, result, aSymbol);
                }
                break;
            }
        }
        return aSymbol;
    }

    /**
     * findSymbolAddr(sSymbol)
     *
     * Search aSymbolTable for sSymbol, and if found, return a dbgAddr (same as parseAddr())
     *
     * @this {DebuggerX80}
     * @param {string} sSymbol
     * @return {DbgAddrX80|undefined}
     */
    findSymbolAddr(sSymbol)
    {
        var dbgAddr;
        if (sSymbol.match(/^[a-z_][a-z0-9_]*$/i)) {
            var sUpperCase = sSymbol.toUpperCase();
            for (var iTable = 0; iTable < this.aSymbolTable.length; iTable++) {
                var symbolTable = this.aSymbolTable[iTable];
                var symbol = symbolTable.aSymbols[sUpperCase];
                if (symbol !== undefined) {
                    var offSymbol = symbol['o'];
                    if (offSymbol !== undefined) {
                        /*
                         * We assume that every ROM is ORG'ed at 0x0000, and therefore unless the symbol has an
                         * explicitly-defined segment, we return the segment associated with the entire group; for
                         * a ROM, that segment is normally "addrROM >>> 4".  Down the road, we may want/need to
                         * support a special symbol entry (eg, ".ORG") that defines an alternate origin.
                         */
                        dbgAddr = this.newAddr(offSymbol);
                    }
                    /*
                     * The symbol matched, but it wasn't for an address (no 'o' offset), and there's no point
                     * looking any farther, since each symbol appears only once, so we indicate it's an unknown symbol.
                     */
                    break;
                }
            }
        }
        return dbgAddr;
    }

    /**
     * returnSymbol(iTable, iOffset, aSymbol)
     *
     * Helper function for findSymbol().
     *
     * @param {number} iTable
     * @param {number} iOffset
     * @param {Array} aSymbol is updated with the specified symbol, if it exists
     */
    returnSymbol(iTable, iOffset, aSymbol)
    {
        var symbol = {};
        var aOffsets = this.aSymbolTable[iTable].aOffsets;
        var offset = 0, sSymbol = null;
        if (iOffset >= 0 && iOffset < aOffsets.length) {
            offset = aOffsets[iOffset][0];
            sSymbol = aOffsets[iOffset][1];
        }
        if (sSymbol) {
            symbol = this.aSymbolTable[iTable].aSymbols[sSymbol];
            sSymbol = (sSymbol.charAt(0) == '.'? null : (symbol['l'] || sSymbol));
        }
        aSymbol.push(sSymbol);
        aSymbol.push(offset);
        aSymbol.push(symbol['a']);
        aSymbol.push(symbol['c']);
    }

    /**
     * doHelp()
     *
     * @this {DebuggerX80}
     */
    doHelp()
    {
        var s = "commands:";
        for (var sCommand in DebuggerX80.COMMANDS) {
            s += '\n' + Str.pad(sCommand, 9) + DebuggerX80.COMMANDS[sCommand];
        }
        if (!this.checksEnabled()) s += "\nnote: frequency/history disabled if no exec breakpoints";
        this.println(s);
    }

    /**
     * doAssemble(asArgs)
     *
     * This always receives the complete argument array, where the order of the arguments is:
     *
     *      [0]: the assemble command (assumed to be "a")
     *      [1]: the target address (eg, "200")
     *      [2]: the operation code, aka instruction name (eg, "adc")
     *      [3]: the operation mode operand, if any (eg, "14", "[1234]", etc)
     *
     * The Debugger enters "assemble mode" whenever only the first (or first and second) arguments are present.
     * As long as "assemble mode is active, the user can omit the first two arguments on all later assemble commands
     * until "assemble mode" is cancelled with an empty command line; the command processor automatically prepends "a"
     * and the next available target address to the argument array.
     *
     * Entering "assemble mode" is optional; one could enter a series of fully-qualified assemble commands; eg:
     *
     *      a ff00 cld
     *      a ff01 ldx 28
     *      ...
     *
     * without ever entering "assemble mode", but of course, that requires more typing and doesn't take advantage
     * of automatic target address advancement (see dbgAddrAssemble).
     *
     * NOTE: As the previous example implies, you can even assemble new instructions into ROM address space;
     * as our setByte() function explains, the ROM write-notification handlers only refuse writes from the CPU.
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs is the complete argument array, beginning with the "a" command in asArgs[0]
     */
    doAssemble(asArgs)
    {
        var dbgAddr = this.parseAddr(asArgs[1], true);
        if (!dbgAddr) return;

        this.dbgAddrAssemble = dbgAddr;
        if (asArgs[2] === undefined) {
            this.println("begin assemble at " + this.toHexAddr(dbgAddr));
            this.fAssemble = true;
            this.cpu.updateCPU();
            return;
        }

        var aOpBytes = this.parseInstruction(asArgs[2], asArgs[3], dbgAddr);
        if (aOpBytes.length) {
            for (var i = 0; i < aOpBytes.length; i++) {
                this.setByte(dbgAddr, aOpBytes[i], 1);
            }
            /*
             * Since getInstruction() also updates the specified address, dbgAddrAssemble is automatically advanced.
             */
            this.println(this.getInstruction(this.dbgAddrAssemble));
        }
    }

    /**
     * doBreak(sCmd, sAddr, sOptions)
     *
     * As the "help" output below indicates, the following breakpoint commands are supported:
     *
     *      bp [a]  set exec breakpoint on linear addr [a]
     *      br [a]  set read breakpoint on linear addr [a]
     *      bw [a]  set write breakpoint on linear addr [a]
     *      bc [a]  clear breakpoint on linear addr [a] (use "*" for all breakpoints)
     *      bl      list breakpoints
     *
     * to which we have recently added the following I/O breakpoint commands:
     *
     *      bi [p]  toggle input breakpoint on port [p] (use "*" for all input ports)
     *      bo [p]  toggle output breakpoint on port [p] (use "*" for all output ports)
     *
     * These two new commands operate as toggles so that if "*" is used to trap all input (or output),
     * you can also use these commands to NOT trap specific ports.
     *
     *      bn [n]  break after [n] instructions
     *
     * TODO: Update the "bl" command to include any/all I/O breakpoints, and the "bc" command to
     * clear them.  Because "bi" and "bo" commands are piggy-backing on Bus functions, those breakpoints
     * are currently outside the realm of what the "bl" and "bc" commands are aware of.
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     * @param {string|undefined} [sAddr]
     * @param {string} [sOptions] (the rest of the breakpoint command-line)
     */
    doBreak(sCmd, sAddr, sOptions)
    {
        if (sAddr == '?') {
            this.println("breakpoint commands:");
            this.println("\tbi [p]\ttoggle break on input port [p]");
            this.println("\tbo [p]\ttoggle break on output port [p]");
            this.println("\tbp [a]\tset exec breakpoint at addr [a]");
            this.println("\tbr [a]\tset read breakpoint at addr [a]");
            this.println("\tbw [a]\tset write breakpoint at addr [a]");
            this.println("\tbc [a]\tclear breakpoint at addr [a]");
            this.println("\tbl\tlist all breakpoints");
            this.println("\tbn [n]\tbreak after [n] instruction(s)");
            return;
        }

        var sParm = sCmd.charAt(1);
        if (sParm == 'l') {
            var cBreaks = 0;
            cBreaks += this.listBreakpoints(this.aBreakExec);
            cBreaks += this.listBreakpoints(this.aBreakRead);
            cBreaks += this.listBreakpoints(this.aBreakWrite);
            if (!cBreaks) this.println("no breakpoints");
            return;
        }

        if (sParm == 'n') {
            this.nBreakIns = this.parseValue(sAddr);
            this.println("break after " + this.nBreakIns + " instruction(s)");
            return;
        }

        if (sAddr === undefined) {
            this.println("missing breakpoint address");
            return;
        }

        var dbgAddr = this.newAddr();
        if (sAddr != '*') {
            dbgAddr = this.parseAddr(sAddr, true, true);
            if (!dbgAddr) return;
        }

        sAddr = Str.toHexWord(dbgAddr.addr);

        if (sParm == 'c') {
            if (dbgAddr.addr == null) {
                this.clearBreakpoints();
                this.println("all breakpoints cleared");
                return;
            }
            if (this.findBreakpoint(this.aBreakExec, dbgAddr, true))
                return;
            if (this.findBreakpoint(this.aBreakRead, dbgAddr, true))
                return;
            if (this.findBreakpoint(this.aBreakWrite, dbgAddr, true))
                return;
            this.println("breakpoint missing: " + this.toHexAddr(dbgAddr));
            return;
        }

        if (sParm == 'i') {
            this.println("breakpoint " + (this.bus.addPortInputBreak(dbgAddr.addr)? "enabled" : "cleared") + ": port " + sAddr + " (input)");
            return;
        }

        if (sParm == 'o') {
            this.println("breakpoint " + (this.bus.addPortOutputBreak(dbgAddr.addr)? "enabled" : "cleared") + ": port " + sAddr + " (output)");
            return;
        }

        if (dbgAddr.addr == null) return;

        this.parseAddrOptions(dbgAddr, sOptions);

        if (sParm == 'p') {
            this.addBreakpoint(this.aBreakExec, dbgAddr);
            return;
        }
        if (sParm == 'r') {
            this.addBreakpoint(this.aBreakRead, dbgAddr);
            return;
        }
        if (sParm == 'w') {
            this.addBreakpoint(this.aBreakWrite, dbgAddr);
            return;
        }
        this.println("unknown breakpoint command: " + sParm);
    }

    /**
     * doClear(sCmd)
     *
     * @this {DebuggerX80}
     * @param {string} [sCmd] (eg, "cls" or "clear")
     */
    doClear(sCmd)
    {
        this.cmp.clearPanel();
    }

    /**
     * doDump(asArgs)
     *
     * The length parameter is interpreted as a number of bytes, in hex, which we convert to the appropriate number
     * of lines, because we always display whole lines.  If the length is omitted/undefined, it defaults to 0x80 (128.)
     * bytes, which normally translates to 8 lines.
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs (formerly sCmd, [sAddr], [sLen] and [sBytes])
     */
    doDump(asArgs)
    {
        var m;
        var sCmd = asArgs[0];
        var sAddr = asArgs[1];
        var sLen = asArgs[2];
        var sBytes = asArgs[3];

        if (sAddr == '?') {
            var sDumpers = "";
            for (m in MessagesX80.CATEGORIES) {
                if (this.afnDumpers[m]) {
                    if (sDumpers) sDumpers += ',';
                    sDumpers = sDumpers + m;
                }
            }
            sDumpers += ",state,symbols";
            this.println("dump memory commands:");
            this.println("\tdb [a] [#]    dump # bytes at address a");
            this.println("\tdw [a] [#]    dump # words at address a");
            this.println("\tdd [a] [#]    dump # dwords at address a");
            this.println("\tdh [#] [#]    dump # instructions from history");
            if (sDumpers.length) this.println("dump extension commands:\n\t" + sDumpers);
            return;
        }

        if (sAddr == "state") {
            var sState = this.cmp.powerOff(true);
            if (sLen == "console") {
                /*
                 * Console buffers are notoriously small, and even the following code, which breaks the
                 * data into parts (eg, "d state console 1", "d state console 2", etc) just isn't that helpful.
                 *
                 *      var nPart = +sBytes;
                 *      if (nPart) sState = sState.substr(1000000 * (nPart-1), 1000000);
                 *
                 * So, the best way to capture a large machine state is to use the new "Save Machine" link
                 * that downloads a machine's entire state.  Alternatively, run your own local server and use
                 * server-side storage.  Take a look at the "Save" binding in computer.js, which binds an HTML
                 * control to the computer.powerOff() and computer.saveServerState() functions.
                 */
                console.log(sState);
            } else {
                this.doClear();
                if (sState) this.println(sState);
            }
            return;
        }

        if (sAddr == "symbols") {
            this.dumpSymbols();
            return;
        }

        if (sCmd == "d") {
            for (m in MessagesX80.CATEGORIES) {
                if (asArgs[1] == m) {
                    var fnDumper = this.afnDumpers[m];
                    if (fnDumper) {
                        asArgs.shift();
                        asArgs.shift();
                        fnDumper(asArgs);
                    } else {
                        this.println("no dump registered for " + sAddr);
                    }
                    return;
                }
            }
            if (!sAddr) sCmd = this.sCmdDumpPrev || "db";
        } else {
            this.sCmdDumpPrev = sCmd;
        }

        if (sCmd == "dh") {
            this.dumpHistory(sAddr, sLen);
            return;
        }

        var dbgAddr = this.parseAddr(sAddr);
        if (!dbgAddr) return;

        var len = 0;                            // 0 is not a default; it triggers the appropriate default below
        if (sLen) {
            if (sLen.charAt(0) == 'l') {
                sLen = sLen.substr(1) || sBytes;
            }
            len = this.parseValue(sLen) >>> 0;  // negative lengths not allowed
            if (len > 0x10000) len = 0x10000;   // prevent bad user (or variable) input from producing excessive output
        }

        var sDump = "";
        var size = (sCmd == "dd"? 4 : (sCmd == "dw"? 2 : 1));
        var cb = (size * len) || 128;
        var cLines = ((cb + 15) >> 4) || 1;

        while (cLines-- && cb > 0) {
            var data = 0, iByte = 0, i;
            var sData = "", sChars = "";
            sAddr = this.toHexAddr(dbgAddr);
            for (i = 16; i > 0 && cb > 0; i--) {
                var b = this.getByte(dbgAddr, 1);
                data |= (b << (iByte++ << 3));
                if (iByte == size) {
                    sData += Str.toHex(data, size * 2);
                    sData += (size == 1? (i == 9? '-' : ' ') : "  ");
                    data = iByte = 0;
                }
                sChars += (b >= 32 && b < 127? String.fromCharCode(b) : '.');
                cb--;
            }
            if (sDump) sDump += '\n';
            sDump += sAddr + "  " + sData + ((i == 0)? (' ' + sChars) : "");
        }

        if (sDump) this.println(sDump);
        this.dbgAddrNextData = dbgAddr;
    }

    /**
     * doEdit(asArgs)
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs
     */
    doEdit(asArgs)
    {
        var size = 1;
        var mask = 0xff;
        var fnGet = this.getByte;
        var fnSet = this.setByte;
        if (asArgs[0] == "ew") {
            size = 2;
            mask = 0xffff;
            fnGet = this.getShort;
            fnSet = this.setShort;
        }
        var cch = size << 1;

        var sAddr = asArgs[1];
        if (sAddr == null) {
            this.println("edit memory commands:");
            this.println("\teb [a] [...]  edit bytes at address a");
            this.println("\tew [a] [...]  edit words at address a");
            return;
        }

        var dbgAddr = this.parseAddr(sAddr);
        if (!dbgAddr) return;

        for (var i = 2; i < asArgs.length; i++) {
            var vNew = this.parseExpression(asArgs[i]);
            if (vNew === undefined) {
                this.println("unrecognized value: " + asArgs[i]);
                break;
            }
            if (vNew & ~mask) {
                this.println("warning: " + Str.toHex(vNew) + " exceeds " + size + "-byte value");
            }
            var vOld = fnGet.call(this, dbgAddr);
            this.println("changing " + this.toHexAddr(dbgAddr) + " from " + Str.toHex(vOld, cch, true) + " to " + Str.toHex(vNew, cch, true));
            fnSet.call(this, dbgAddr, vNew, size);
        }
    }

    /**
     * doFreqs(sParm)
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sParm
     */
    doFreqs(sParm)
    {
        if (sParm == '?') {
            this.println("frequency commands:");
            this.println("\tclear\tclear all frequency counts");
            return;
        }
        var i;
        var cData = 0;
        if (this.aaOpcodeCounts) {
            if (sParm == "clear") {
                for (i = 0; i < this.aaOpcodeCounts.length; i++)
                    this.aaOpcodeCounts[i] = [i, 0];
                this.println("frequency data cleared");
                cData++;
            }
            else if (sParm !== undefined) {
                this.println("unknown frequency command: " + sParm);
                cData++;
            }
            else {
                var aaSortedOpcodeCounts = this.aaOpcodeCounts.slice();
                aaSortedOpcodeCounts.sort(function(p, q) {
                    return q[1] - p[1];
                });
                var asOpcodes = this.style != DebuggerX80.STYLE_8086? DebuggerX80.INS_NAMES : DebuggerX80.INS_NAMES_8086;
                for (i = 0; i < aaSortedOpcodeCounts.length; i++) {
                    var bOpcode = aaSortedOpcodeCounts[i][0];
                    var cFreq = aaSortedOpcodeCounts[i][1];
                    if (cFreq) {
                        this.println((asOpcodes[this.aaOpDescs[bOpcode][0]] + "  ").substr(0, 5) + " (" + Str.toHexByte(bOpcode) + "): " + cFreq + " times");
                        cData++;
                    }
                }
            }
        }
        if (!cData) {
            this.println("no frequency data available");
        }
    }

    /**
     * doHalt(fQuiet)
     *
     * @this {DebuggerX80}
     * @param {boolean} [fQuiet]
     */
    doHalt(fQuiet)
    {
        var sMsg;
        if (this.flags.running) {
            sMsg = "halting";
            this.stopCPU();
        } else {
            if (this.isBusy(true)) return;
            sMsg = "already halted";
        }
        if (!fQuiet) this.println(sMsg);
    }

    /**
     * doIf(sCmd, fQuiet)
     *
     * NOTE: Don't forget that the default base for all numeric constants is 16 (hex), so when you evaluate
     * an expression like "a==10", it will compare the value of the variable "a" to 0x10; use a trailing period
     * (eg, "10.") if you really intend decimal.
     *
     * Also, if no variable named "a" exists, "a" will evaluate to 0x0A, so the expression "a==10" becomes
     * "0x0A==0x10" (false), whereas the expression "a==10." becomes "0x0A==0x0A" (true).
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     * @param {boolean} [fQuiet]
     * @return {boolean} true if expression is non-zero, false if zero (or undefined due to a parse error)
     */
    doIf(sCmd, fQuiet)
    {
        sCmd = Str.trim(sCmd);
        if (!this.parseExpression(sCmd)) {
            if (!fQuiet) this.println("false: " + sCmd);
            return false;
        }
        if (!fQuiet) this.println("true: " + sCmd);
        return true;
    }

    /**
     * doInfo(asArgs)
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs
     * @return {boolean} true only if the instruction info command ("n") is supported
     */
    doInfo(asArgs)
    {
        if (DEBUG) {
            this.println("msPerYield: " + this.cpu.msPerYield);
            this.println("nCyclesPerYield: " + this.cpu.nCyclesPerYield);
            return true;
        }
        return false;
    }

    /**
     * doInput(sPort)
     *
     * Simulate a 1-byte port input operation.
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sPort
     */
    doInput(sPort)
    {
        if (!sPort || sPort == '?') {
            this.println("input commands:");
            this.println("\ti [p]\tread port [p]");
            /*
             * TODO: Regarding this warning, consider adding an "unchecked" version of
             * bus.checkPortInputNotify(), since all Debugger memory accesses are unchecked, too.
             *
             * All port I/O handlers ARE aware when the Debugger is calling (addrFrom is undefined),
             * but changing them all to be non-destructive would take time, and situations where you
             * actually want to affect the hardware state are just as likely as not....
             */
            this.println("warning: port accesses can affect hardware state");
            return;
        }
        var port = this.parseValue(sPort);
        if (port !== undefined) {
            var bIn = this.bus.checkPortInputNotify(port, 1);
            this.println(Str.toHexWord(port) + ": " + Str.toHexByte(bIn));
        }
    }

    /**
     * doInt(sLevel)
     *
     * @this {DebuggerX80}
     * @param {string} sLevel
     * @return {boolean} true if success, false if error
     */
    doInt(sLevel)
    {
        if (!this.cpu.getIF()) {
            this.println("interrupts disabled (use rif=1 to enable)");
            return false;
        }
        var nLevel = this.parseExpression(sLevel);
        if (nLevel == null) return false;
        this.println("requesting interrupt level " + nLevel);
        this.cpu.requestINTR(nLevel);
        return true;
    }

    /**
     * doVar(sCmd)
     *
     * The command must be of the form "{variable} = [{expression}]", where expression may contain constants,
     * operators, registers, symbols, other variables, or nothing at all; in the latter case, the variable, if
     * any, is deleted.
     *
     * Other supported shorthand: "var" with no parameters prints the values of all variables, and "var {variable}"
     * prints the value of the specified variable.
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     * @return {boolean} true if valid "var" assignment, false if not
     */
    doVar(sCmd)
    {
        var a = sCmd.match(/^\s*([A-Z_]?[A-Z0-9_]*)\s*(=?)\s*(.*)$/i);
        if (a) {
            if (!a[1]) {
                if (!this.printVariable()) this.println("no variables");
                return true;    // it's not considered an error to print an empty list of variables
            }
            if (!a[2]) {
                return this.printVariable(a[1]);
            }
            if (!a[3]) {
                this.delVariable(a[1]);
                return true;    // it's not considered an error to delete a variable that didn't exist
            }
            var v = this.parseExpression(a[3]);
            if (v !== undefined) {
                this.setVariable(a[1], v);
                return true;
            }
            return false;
        }
        this.println("invalid assignment:" + sCmd);
        return false;
    }

    /**
     * doList(sAddr, fPrint)
     *
     * @this {DebuggerX80}
     * @param {string} sAddr
     * @param {boolean} [fPrint]
     * @return {string|null}
     */
    doList(sAddr, fPrint)
    {
        var sSymbol = null;

        var dbgAddr = this.parseAddr(sAddr, true);
        if (dbgAddr) {
            var addr = this.getAddr(dbgAddr);
            var aSymbol = this.findSymbol(dbgAddr, true);
            if (aSymbol.length) {
                var nDelta, sDelta, s;
                if (aSymbol[0]) {
                    sDelta = "";
                    nDelta = dbgAddr.addr - aSymbol[1];
                    if (nDelta) sDelta = " + " + Str.toHexWord(nDelta);
                    s = aSymbol[0] + " (" + this.toHexOffset(aSymbol[1]) + ')' + sDelta;
                    if (fPrint) this.println(s);
                    sSymbol = s;
                }
                if (aSymbol.length > 4 && aSymbol[4]) {
                    sDelta = "";
                    nDelta = aSymbol[5] - dbgAddr.addr;
                    if (nDelta) sDelta = " - " + Str.toHexWord(nDelta);
                    s = aSymbol[4] + " (" + this.toHexOffset(aSymbol[5]) + ')' + sDelta;
                    if (fPrint) this.println(s);
                    if (!sSymbol) sSymbol = s;
                }
            } else {
                if (fPrint) this.println("no symbols");
            }
        }
        return sSymbol;
    }

    /**
     * doMessages(asArgs)
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs
     */
    doMessages(asArgs)
    {
        var m;
        var fCriteria = null;
        var sCategory = asArgs[1];
        if (sCategory == '?') sCategory = undefined;

        if (sCategory !== undefined) {
            var bitsMessage = 0;
            if (sCategory == "all") {
                bitsMessage = (0xffffffff|0) & ~(MessagesX80.HALT | MessagesX80.KEYS | MessagesX80.BUFFER);
                sCategory = null;
            } else if (sCategory == "on") {
                fCriteria = true;
                sCategory = null;
            } else if (sCategory == "off") {
                fCriteria = false;
                sCategory = null;
            } else {
                /*
                 * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
                 * but externally, we allow the user to specify "keys"; "kbd" is also allowed as shorthand for "keyboard".
                 */
                if (sCategory == "keys") sCategory = "key";
                if (sCategory == "kbd") sCategory = "keyboard";
                for (m in MessagesX80.CATEGORIES) {
                    if (sCategory == m) {
                        bitsMessage = MessagesX80.CATEGORIES[m];
                        fCriteria = !!(this.bitsMessage & bitsMessage);
                        break;
                    }
                }
                if (!bitsMessage) {
                    this.println("unknown message category: " + sCategory);
                    return;
                }
            }
            if (bitsMessage) {
                if (asArgs[2] == "on") {
                    this.bitsMessage |= bitsMessage;
                    fCriteria = true;
                }
                else if (asArgs[2] == "off") {
                    this.bitsMessage &= ~bitsMessage;
                    fCriteria = false;
                    if (bitsMessage == MessagesX80.BUFFER) {
                        for (var i = 0; i < this.aMessageBuffer.length; i++) {
                            this.println(this.aMessageBuffer[i]);
                        }
                        this.aMessageBuffer = [];
                    }
                }
            }
        }

        /*
         * Display those message categories that match the current criteria (on or off)
         */
        var n = 0;
        var sCategories = "";
        for (m in MessagesX80.CATEGORIES) {
            if (!sCategory || sCategory == m) {
                var bitMessage = MessagesX80.CATEGORIES[m];
                var fEnabled = !!(this.bitsMessage & bitMessage);
                if (fCriteria !== null && fCriteria != fEnabled) continue;
                if (sCategories) sCategories += ',';
                if (!(++n % 10)) sCategories += "\n\t";     // jshint ignore:line
                /*
                 * Internally, we use "key" instead of "keys", since the latter is a method on JavasScript objects,
                 * but externally, we allow the user to specify "keys".
                 */
                if (m == "key") m = "keys";
                sCategories += m;
            }
        }

        if (sCategory === undefined) {
            this.println("message commands:\n\tm [category] [on|off]\tturn categories on/off");
        }

        this.println((fCriteria !== null? (fCriteria? "messages on:  " : "messages off: ") : "message categories:\n\t") + (sCategories || "none"));

        this.historyInit();     // call this just in case MessagesX80.INT was turned on
    }

    /**
     * doOptions(asArgs)
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs
     */
    doOptions(asArgs)
    {
        switch (asArgs[1]) {
        case "8080":
            this.style = DebuggerX80.STYLE_8080;
            break;

        case "8086":
            this.style = DebuggerX80.STYLE_8086;
            break;

        case "cs":
            var nCycles;
            if (asArgs[3] !== undefined) nCycles = +asArgs[3];          // warning: decimal instead of hex conversion
            switch (asArgs[2]) {
                case "int":
                    this.cpu.nCyclesChecksumInterval = nCycles;
                    break;
                case "start":
                    this.cpu.nCyclesChecksumStart = nCycles;
                    break;
                case "stop":
                    this.cpu.nCyclesChecksumStop = nCycles;
                    break;
                default:
                    this.println("unknown cs option");
                    return;
            }
            if (nCycles !== undefined) {
                this.cpu.resetChecksum();
            }
            this.println("checksums " + (this.cpu.flags.checksum? "enabled" : "disabled"));
            return;

        case "sp":
            if (asArgs[2] !== undefined) {
                if (!this.cpu.setSpeed(+asArgs[2])) {
                    this.println("warning: using 1x multiplier, previous target not reached");
                }
            }
            this.println("target speed: " + this.cpu.getSpeedTarget() + " (" + this.cpu.getSpeed() + "x)");
            return;

        case "?":
            this.println("debugger options:");
            this.println("\tX80\t\tselect 8080-style mnemonics");
            this.println("\t8086\t\tselect 8086-style mnemonics");
            this.println("\tcs int #\tset checksum cycle interval to #");
            this.println("\tcs start #\tset checksum cycle start count to #");
            this.println("\tcs stop #\tset checksum cycle stop count to #");
            this.println("\tsp #\t\tset speed multiplier to #");
            break;

        default:
            if (asArgs[1]) {
                this.println("unknown option: " + asArgs[1]);
                return;
            }
            break;
        }
        this.println(this.style + "-style mnemonics enabled");
    }

    /**
     * doOutput(sPort, sByte)
     *
     * Simulate a 1-byte port output operation.
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sPort
     * @param {string|undefined} sByte (string representation of 1 byte)
     */
    doOutput(sPort, sByte)
    {
        if (!sPort || sPort == '?') {
            this.println("output commands:");
            this.println("\to [p] [b]\twrite byte [b] to port [p]");
            /*
             * TODO: Regarding this warning, consider adding an "unchecked" version of
             * bus.checkPortOutputNotify(), since all Debugger memory accesses are unchecked, too.
             *
             * All port I/O handlers ARE aware when the Debugger is calling (addrFrom is undefined),
             * but changing them all to be non-destructive would take time, and situations where you
             * actually want to affect the hardware state are just as likely as not....
             */
            this.println("warning: port accesses can affect hardware state");
            return;
        }
        var port = this.parseValue(sPort, "port #");
        var bOut = this.parseValue(sByte);
        if (port !== undefined && bOut !== undefined) {
            this.bus.checkPortOutputNotify(port, 1, bOut);
            this.println(Str.toHexWord(port) + ": " + Str.toHexByte(bOut));
        }
    }

    /**
     * doRegisters(asArgs, fInstruction)
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} [asArgs]
     * @param {boolean} [fInstruction] (true to include the current instruction; default is true)
     */
    doRegisters(asArgs, fInstruction)
    {
        if (asArgs && asArgs[1] == '?') {
            this.println("register commands:");
            this.println("\tr\tdump registers");
            this.println("\trx [#]\tset flag or register x to [#]");
            return;
        }

        var cpu = this.cpu;
        if (fInstruction == null) fInstruction = true;

        if (asArgs != null && asArgs.length > 1) {
            var sReg = asArgs[1];
            var sValue = null;
            var i = sReg.indexOf('=');
            if (i > 0) {
                sValue = sReg.substr(i + 1);
                sReg = sReg.substr(0, i);
            }
            else if (asArgs.length > 2) {
                sValue = asArgs[2];
            }
            else {
                this.println("missing value for " + asArgs[1]);
                return;
            }

            var w = this.parseExpression(sValue);
            if (w === undefined) return;

            var sRegMatch = sReg.toUpperCase();
            switch (sRegMatch) {
            case "A":
                cpu.regA = w & 0xff;
                break;
            case "B":
                cpu.regB = w & 0xff;
                break;
            case "BC":
                cpu.regB = ((w >> 8) & 0xff);
                /* falls through */
            case "C":
                cpu.regC = w & 0xff;
                break;
            case "D":
                cpu.regD = w & 0xff;
                break;
            case "DE":
                cpu.regD = ((w >> 8) & 0xff);
                /* falls through */
            case "E":
                cpu.regE = w & 0xff;
                break;
            case "H":
                cpu.regH = w & 0xff;
                break;
            case "HL":
                cpu.regH = ((w >> 8) & 0xff);
                /* falls through */
            case "L":
                cpu.regL = w & 0xff;
                break;
            case "SP":
                cpu.setSP(w);
                break;
            case "PC":
                cpu.setPC(w);
                this.dbgAddrNextCode = this.newAddr(cpu.getPC());
                break;
            case "PS":
                cpu.setPS(w);
                break;
            case "PSW":
                cpu.setPSW(w);
                break;
            case "CF":
                if (w) cpu.setCF(); else cpu.clearCF();
                break;
            case "PF":
                if (w) cpu.setPF(); else cpu.clearPF();
                break;
            case "AF":
                if (w) cpu.setAF(); else cpu.clearAF();
                break;
            case "ZF":
                if (w) cpu.setZF(); else cpu.clearZF();
                break;
            case "SF":
                if (w) cpu.setSF(); else cpu.clearSF();
                break;
            case "IF":
                if (w) cpu.setIF(); else cpu.clearIF();
                break;
            default:
                this.println("unknown register: " + sReg);
                return;
            }
            cpu.updateCPU();
            this.println("updated registers:");
        }

        this.println(this.getRegDump());

        if (fInstruction) {
            this.dbgAddrNextCode = this.newAddr(cpu.getPC());
            this.doUnassemble(this.toHexAddr(this.dbgAddrNextCode));
        }
    }

    /**
     * doRun(sCmd, sAddr, sOptions, fQuiet)
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     * @param {string|undefined} [sAddr]
     * @param {string} [sOptions] (the rest of the breakpoint command-line)
     * @param {boolean} [fQuiet]
     */
    doRun(sCmd, sAddr, sOptions, fQuiet)
    {
        if (sCmd == "gt") {
            this.fIgnoreNextCheckFault = true;
        }
        if (sAddr !== undefined) {
            var dbgAddr = this.parseAddr(sAddr, true);
            if (!dbgAddr) return;
            this.parseAddrOptions(dbgAddr, sOptions);
            this.setTempBreakpoint(dbgAddr);
        }
        if (!this.runCPU(true)) {
            if (!fQuiet) this.println("cpu busy or unavailable, run command ignored");
        }
    }

    /**
     * doPrint(sCmd)
     *
     * NOTE: If the string to print is a quoted string, then we run it through replaceRegs(), so that
     * you can take advantage of all the special replacement options used for software interrupt logging.
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     */
    doPrint(sCmd)
    {
        sCmd = Str.trim(sCmd);
        var a = sCmd.match(/^(['"])(.*?)\1$/);
        if (!a) {
            this.parseExpression(sCmd, false);
        } else {
            this.println(this.replaceRegs(a[2]));
        }
    }

    /**
     * doStep(sCmd)
     *
     * @this {DebuggerX80}
     * @param {string} [sCmd] "p" or "pr"
     */
    doStep(sCmd)
    {
        var fCallStep = true;
        var fRegs = (sCmd == "pr"? 1 : 0);
        /*
         * Set up the value for this.nStep (ie, 1 or 2) depending on whether the user wants
         * a subsequent register dump ("pr") or not ("p").
         */
        var nStep = 1 + fRegs;
        if (!this.nStep) {
            var dbgAddr = this.newAddr(this.cpu.getPC());
            var bOpcode = this.getByte(dbgAddr);

            switch (bOpcode) {
            case CPUDefX80.OPCODE.CALL:
                if (fCallStep) {
                    this.nStep = nStep;
                    this.incAddr(dbgAddr, 3);
                }
                break;
            default:
                break;
            }

            if (this.nStep) {
                this.setTempBreakpoint(dbgAddr);
                if (!this.runCPU()) {
                    if (this.cmp) this.cmp.updateFocus();
                    this.nStep = 0;
                }
                /*
                 * A successful run will ultimately call stop(), which will in turn call clearTempBreakpoint(),
                 * which will clear nStep, so there's your assurance that nStep will be reset.  Now we may have
                 * stopped for reasons unrelated to the temporary breakpoint, but that's OK.
                 */
            } else {
                this.doTrace(fRegs? "tr" : "t");
            }
        } else {
            this.println("step in progress");
        }
    }

    /**
     * getCall(dbgAddr)
     *
     * Given a possible return address (typically from the stack), look for a matching CALL (or INT) that
     * immediately precedes that address.
     *
     * @this {DebuggerX80}
     * @param {DbgAddrX80} dbgAddr
     * @return {string|null} CALL instruction at or near dbgAddr, or null if none
     */
    getCall(dbgAddr)
    {
        var sCall = null;
        var addr = dbgAddr.addr;
        var addrOrig = addr;
        for (var n = 1; n <= 6 && !!addr; n++) {
            if (n > 2) {
                dbgAddr.addr = addr;
                var s = this.getInstruction(dbgAddr);
                if (s.indexOf("CALL") >= 0) {
                    /*
                     * Verify that the length of this CALL (or INT), when added to the address of the CALL (or INT),
                     * matches the original return address.  We do this by getting the string index of the opcode bytes,
                     * subtracting that from the string index of the next space, and dividing that difference by two,
                     * to yield the length of the CALL (or INT) instruction, in bytes.
                     */
                    var i = s.indexOf(' ');
                    var j = s.indexOf(' ', i+1);
                    if (addr + (j - i - 1)/2 == addrOrig) {
                        sCall = s;
                        break;
                    }
                }
            }
            addr--;
        }
        dbgAddr.addr = addrOrig;
        return sCall;
    }

    /**
     * doStackTrace(sCmd, sAddr)
     *
     * Use "k" for a normal stack trace and "ks" for a stack trace with symbolic info.
     *
     * @this {DebuggerX80}
     * @param {string} [sCmd]
     * @param {string} [sAddr] (not used yet)
     */
    doStackTrace(sCmd, sAddr)
    {
        if (sAddr == '?') {
            this.println("stack trace commands:");
            this.println("\tk\tshow frame addresses");
            this.println("\tks\tshow symbol information");
            return;
        }

        var nFrames = 10, cFrames = 0;
        var dbgAddrCall = this.newAddr();
        var dbgAddrStack = this.newAddr(this.cpu.getSP());
        this.println("stack trace for " + this.toHexAddr(dbgAddrStack));

        while (cFrames < nFrames) {
            var sCall = null, sCallPrev = null, cTests = 256;
            while ((dbgAddrStack.addr >>> 0) < 0x10000) {
                dbgAddrCall.addr = this.getWord(dbgAddrStack, true);
                /*
                 * Because we're using the auto-increment feature of getWord(), and because that will automatically
                 * wrap the offset around the end of the segment, we must also check the addr property to detect the wrap.
                 */
                if (dbgAddrStack.addr == null || !cTests--) break;
                sCall = this.getCall(dbgAddrCall);
                if (sCall) break;
            }
            /*
             * The sCallPrev check eliminates duplicate sequential calls, which are usually (but not always)
             * indicative of a false positive, in which case the previous call is probably bogus as well, but
             * at least we won't duplicate that mistake.  Of course, there are always exceptions, recursion
             * being one of them, but it's rare that we're debugging recursive code.
             */
            if (!sCall || sCall == sCallPrev) break;
            var sSymbol = null;
            if (sCmd == "ks") {
                var a = sCall.match(/[0-9A-F]+$/);
                if (a) sSymbol = this.doList(a[0]);
            }
            sCall = Str.pad(sCall, 50) + "  ;" + (sSymbol || "stack=" + this.toHexAddr(dbgAddrStack)); // + " return=" + this.toHexAddr(dbgAddrCall));
            this.println(sCall);
            sCallPrev = sCall;
            cFrames++;
        }
        if (!cFrames) this.println("no return addresses found");
    }

    /**
     * doTrace(sCmd, sCount)
     *
     * The "t" and "tr" commands interpret the count as a number of instructions, and since
     * we call the Debugger's stepCPU() for each iteration, a single instruction includes
     * any/all prefixes; the CPU's stepCPU() treats prefixes as discrete operations.  The only
     * difference between "t" and "tr": the former displays only the next instruction, while
     * the latter also displays the (updated) registers.
     *
     * The "tc" command interprets the count as a number of cycles rather than instructions,
     * allowing you to quickly execute large chunks of instructions with a single command; it
     * doesn't display anything until the the chunk has finished.
     *
     * However, generally a more useful command is "bn", which allows you to break after some
     * number of instructions have been executed (as opposed to some number of cycles).
     *
     * @this {DebuggerX80}
     * @param {string} [sCmd] ("t", "tc", or "tr")
     * @param {string} [sCount] # of instructions to step
     */
    doTrace(sCmd, sCount)
    {
        var dbg = this;
        var fRegs = (sCmd != "t");
        var nCount = this.parseValue(sCount, undefined, true) || 1;
        var nCycles = (nCount == 1? 0 : 1);
        if (sCmd == "tc") {
            nCycles = nCount;
            nCount = 1;
        }
        Web.onCountRepeat(
            nCount,
            function onCountStep() {
                return dbg.setBusy(true) && dbg.stepCPU(nCycles, fRegs, false);
            },
            function onCountStepComplete() {
                /*
                 * We explicitly called stepCPU() with fUpdateCPU === false, because repeatedly
                 * calling updateCPU() can be very slow, especially when fDisplayLiveRegs is true,
                 * so once the repeat count has been exhausted, we must perform a final updateCPU().
                 */
                dbg.cpu.updateCPU();
                dbg.setBusy(false);
            }
        );
    }

    /**
     * doUnassemble(sAddr, sAddrEnd, n)
     *
     * @this {DebuggerX80}
     * @param {string} [sAddr]
     * @param {string} [sAddrEnd]
     * @param {number} [n]
     */
    doUnassemble(sAddr, sAddrEnd, n)
    {
        var dbgAddr = this.parseAddr(sAddr, true);
        if (!dbgAddr) return;

        if (n === undefined) n = 1;

        var cb = 0x100;
        if (sAddrEnd !== undefined) {

            var dbgAddrEnd = this.parseAddr(sAddrEnd, true);
            if (!dbgAddrEnd || dbgAddrEnd.addr < dbgAddr.addr) return;

            cb = dbgAddrEnd.addr - dbgAddr.addr;
            if (!DEBUG && cb > 0x100) {
                /*
                 * Limiting the amount of disassembled code to 256 bytes in non-DEBUG builds is partly to
                 * prevent the user from wedging the browser by dumping too many lines, but also a recognition
                 * that, in non-DEBUG builds, this.println() keeps print output buffer truncated to 8Kb anyway.
                 */
                this.println("range too large");
                return;
            }
            n = -1;
        }

        var cLines = 0;
        var sInstruction;

        while (cb > 0 && n--) {

            var nSequence = (this.isBusy(false) || this.nStep)? this.nCycles : null;
            var sComment = (nSequence != null? "cycles" : null);
            var aSymbol = this.findSymbol(dbgAddr);

            var addr = dbgAddr.addr;    // we snap dbgAddr.addr *after* calling findSymbol(), which re-evaluates it

            if (aSymbol[0] && n) {
                if (!cLines && n || aSymbol[0].indexOf('+') < 0) {
                    var sLabel = aSymbol[0] + ':';
                    if (aSymbol[2]) sLabel += ' ' + aSymbol[2];
                    this.println(sLabel);
                }
            }

            if (aSymbol[3]) {
                sComment = aSymbol[3];
                nSequence = null;
            }

            sInstruction = this.getInstruction(dbgAddr, sComment, nSequence);

            this.println(sInstruction);
            this.dbgAddrNextCode = dbgAddr;
            cb -= dbgAddr.addr - addr;
            cLines++;
        }
    }

    /**
     * parseCommand(sCmd, fSave, chSep)
     *
     * @this {DebuggerX80}
     * @param {string|undefined} sCmd
     * @param {boolean} [fSave] is true to save the command, false if not
     * @param {string} [chSep] is the command separator character (default is ';')
     * @return {Array.<string>}
     */
    parseCommand(sCmd, fSave, chSep)
    {
        if (fSave) {
            if (!sCmd) {
                if (this.fAssemble) {
                    sCmd = "end";
                } else {
                    sCmd = this.aPrevCmds[this.iPrevCmd+1];
                }
            } else {
                if (this.iPrevCmd < 0 && this.aPrevCmds.length) {
                    this.iPrevCmd = 0;
                }
                if (this.iPrevCmd < 0 || sCmd != this.aPrevCmds[this.iPrevCmd]) {
                    this.aPrevCmds.splice(0, 0, sCmd);
                    this.iPrevCmd = 0;
                }
                this.iPrevCmd--;
            }
        }
        var a = [];
        if (sCmd) {
            /*
             * With the introduction of breakpoint commands (ie, quoted command sequences
             * associated with a breakpoint), we can no longer perform simplistic splitting.
             *
             *      a = sCmd.split(chSep || ';');
             *      for (var i = 0; i < a.length; i++) a[i] = str.trim(a[i]);
             *
             * We may now split on semi-colons ONLY if they are outside a quoted sequence.
             *
             * Also, to allow quoted strings *inside* breakpoint commands, we first replace all
             * DOUBLE double-quotes with single quotes.
             */
            sCmd = sCmd.toLowerCase().replace(/""/g, "'");

            var iPrev = 0;
            var chQuote = null;
            chSep = chSep || ';';
            /*
             * NOTE: Processing charAt() up to and INCLUDING length is not a typo; we're taking
             * advantage of the fact that charAt() with an invalid index returns an empty string,
             * allowing us to use the same substring() call to capture the final portion of sCmd.
             *
             * In a sense, it allows us to pretend that the string ends with a zero terminator.
             */
            for (var i = 0; i <= sCmd.length; i++) {
                var ch = sCmd.charAt(i);
                if (ch == '"' || ch == "'") {
                    if (!chQuote) {
                        chQuote = ch;
                    } else if (ch == chQuote) {
                        chQuote = null;
                    }
                }
                else if (ch == chSep && !chQuote || !ch) {
                    /*
                     * Recall that substring() accepts starting (inclusive) and ending (exclusive)
                     * indexes, whereas substr() accepts a starting index and a length.  We need the former.
                     */
                    a.push(Str.trim(sCmd.substring(iPrev, i)));
                    iPrev = i + 1;
                }
            }
        }
        return a;
    }

    /**
     * shiftArgs(asArgs)
     *
     * Used with any command (eg, "r") that allows but doesn't require whitespace between command and first argument.
     *
     * @this {DebuggerX80}
     * @param {Array.<string>} asArgs
     * @return {Array.<string>}
     */
    shiftArgs(asArgs)
    {
        if (asArgs && asArgs.length) {
            var s0 = asArgs[0];
            var ch0 = s0.charAt(0);
            for (var i = 1; i < s0.length; i++) {
                var ch = s0.charAt(i);
                if (ch0 == '?' || ch0 == 'r' || ch < 'a' || ch > 'z') {
                    asArgs[0] = s0.substr(i);
                    asArgs.unshift(s0.substr(0, i));
                    break;
                }
            }
        }
        return asArgs;
    }

    /**
     * doCommand(sCmd, fQuiet)
     *
     * @this {DebuggerX80}
     * @param {string} sCmd
     * @param {boolean} [fQuiet]
     * @return {boolean} true if command processed, false if unrecognized
     */
    doCommand(sCmd, fQuiet)
    {
        var result = true;

        try {
            if (!sCmd.length || sCmd == "end") {
                if (this.fAssemble) {
                    this.println("ended assemble at " + this.toHexAddr(this.dbgAddrAssemble));
                    this.dbgAddrNextCode = this.dbgAddrAssemble;
                    this.fAssemble = false;
                }
                sCmd = "";
            }
            else if (!fQuiet) {
                var sPrompt = ">> ";
                this.println(sPrompt + sCmd);
            }

            var ch = sCmd.charAt(0);
            if (ch == '"' || ch == "'") return true;

            /*
             * Zap the previous message buffer to ensure the new command's output is not tossed out as a repeat.
             */
            this.sMessagePrev = null;

            /*
             * I've relaxed the !isBusy() requirement, to maximize our ability to issue Debugger commands externally.
             */
            if (this.isReady() /* && !this.isBusy(true) */ && sCmd.length > 0) {

                if (this.fAssemble) {
                    sCmd = "a " + this.toHexAddr(this.dbgAddrAssemble) + ' ' + sCmd;
                }

                var asArgs = this.shiftArgs(sCmd.replace(/ +/g, ' ').split(' '));

                switch (asArgs[0].charAt(0)) {
                case 'a':
                    this.doAssemble(asArgs);
                    break;
                case 'b':
                    this.doBreak(asArgs[0], asArgs[1], sCmd);
                    break;
                case 'c':
                    this.doClear(asArgs[0]);
                    break;
                case 'd':
                    if (!COMPILED && sCmd == "debug") {
                        window.DEBUG = true;
                        this.println("DEBUG checks on");
                        break;
                    }
                    this.doDump(asArgs);
                    break;
                case 'e':
                    if (asArgs[0] == "else") break;
                    this.doEdit(asArgs);
                    break;
                case 'f':
                    this.doFreqs(asArgs[1]);
                    break;
                case 'g':
                    this.doRun(asArgs[0], asArgs[1], sCmd, fQuiet);
                    break;
                case 'h':
                    this.doHalt(fQuiet);
                    break;
                case 'i':
                    if (asArgs[0] == "if") {
                        if (!this.doIf(sCmd.substr(2), fQuiet)) {
                            result = false;
                        }
                        break;
                    }
                    if (asArgs[0] == "int") {
                        if (!this.doInt(asArgs[1])) {
                            result = false;
                        }
                        break;
                    }
                    this.doInput(asArgs[1]);
                    break;
                case 'k':
                    this.doStackTrace(asArgs[0], asArgs[1]);
                    break;
                case 'l':
                    if (asArgs[0] == "ln") {
                        this.doList(asArgs[1], true);
                        break;
                    }
                    break;
                case 'm':
                    this.doMessages(asArgs);
                    break;
                case 'o':
                    this.doOutput(asArgs[1], asArgs[2]);
                    break;
                case 'p':
                    if (asArgs[0] == "print") {
                        this.doPrint(sCmd.substr(5));
                        break;
                    }
                    this.doStep(asArgs[0]);
                    break;
                case 'r':
                    if (sCmd == "reset") {
                        if (this.cmp) this.cmp.reset();
                        break;
                    }
                    this.doRegisters(asArgs);
                    break;
                case 's':
                    this.doOptions(asArgs);
                    break;
                case 't':
                    this.doTrace(asArgs[0], asArgs[1]);
                    break;
                case 'u':
                    this.doUnassemble(asArgs[1], asArgs[2], 8);
                    break;
                case 'v':
                    if (asArgs[0] == "var") {
                        if (!this.doVar(sCmd.substr(3))) {
                            result = false;
                        }
                        break;
                    }
                    this.println((PCx80.APPNAME || "PCx80") + " version " + PCx80.APPVERSION + " (" + this.cpu.model + (PCx80.COMPILED? ",RELEASE" : (PCx80.DEBUG? ",DEBUG" : ",NODEBUG")) + (PCx80.TYPEDARRAYS? ",TYPEDARRAYS" : (PCx80.BYTEARRAYS? ",BYTEARRAYS" : ",LONGARRAYS")) + ')');
                    this.println(Web.getUserAgent());
                    break;
                case '?':
                    if (asArgs[1]) {
                        this.doPrint(sCmd.substr(1));
                        break;
                    }
                    this.doHelp();
                    break;
                case 'n':
                    if (!COMPILED && sCmd == "nodebug") {
                        window.DEBUG = false;
                        this.println("DEBUG checks off");
                        break;
                    }
                    if (this.doInfo(asArgs)) break;
                    /* falls through */
                default:
                    this.println("unknown command: " + sCmd);
                    result = false;
                    break;
                }
            }
        } catch(e) {
            this.println("debugger error: " + (e.stack || e.message));
            result = false;
        }
        return result;
    }

    /**
     * doCommands(sCmds, fSave)
     *
     * @this {DebuggerX80}
     * @param {string} sCmds
     * @param {boolean} [fSave]
     * @return {boolean} true if all commands processed, false if not
     */
    doCommands(sCmds, fSave)
    {
        var a = this.parseCommand(sCmds, fSave);
        for (var s in a) {
            if (!this.doCommand(a[+s])) return false;
        }
        return true;
    }

    /**
     * DebuggerX80.init()
     *
     * This function operates on every HTML element of class "debugger", extracting the
     * JSON-encoded parameters for the Debugger constructor from the element's "data-value"
     * attribute, invoking the constructor to create a Debugger component, and then binding
     * any associated HTML controls to the new component.
     */
    static init()
    {
        var aeDbg = Component.getElementsByClass(document, PCx80.APPCLASS, "debugger");
        for (var iDbg = 0; iDbg < aeDbg.length; iDbg++) {
            var eDbg = aeDbg[iDbg];
            var parmsDbg = Component.getComponentParms(eDbg);
            var dbg = new DebuggerX80(parmsDbg);
            Component.bindComponentControls(dbg, eDbg, PCx80.APPCLASS);
        }
    }
}

if (DEBUGGER) {

    /*
     * NOTE: Every DebuggerX80 property from here to the first prototype function definition (initBus()) is
     * considered a "class constant"; most of them use our "all-caps" convention (and all of them SHOULD, but
     * that wouldn't help us catch any bugs).
     *
     * Technically, all of them should ALSO be preceded by a "@const" annotation, but that's a lot of work and it
     * really clutters the code.  I wish the Closure Compiler had a way to annotate every definition with a given
     * section with a single annotation....
     *
     * Bugs can slip through the cracks without those annotations; for example, I unthinkingly redefined TYPE_SIZE
     * at one point, and if all the definitions had been preceded by an "@const", that mistake would have been
     * caught at compile-time.
     */

    DebuggerX80.COMMANDS = {
        '?':        "help/print",
        'a [#]':    "assemble",             // TODO: Implement this command someday
        'b [#]':    "breakpoint",           // multiple variations (use b? to list them)
        'c':        "clear output",
        'd [#]':    "dump memory",          // additional syntax: d [#] [l#], where l# is a number of bytes to dump
        'e [#]':    "edit memory",
        'f':        "frequencies",
        'g [#]':    "go [to #]",
        'h':        "halt",
        'i [#]':    "input port #",
        'if':       "eval expression",
        'int [#]':  "request interrupt",
        'k':        "stack trace",
        "ln":       "list nearest symbol(s)",
        'm':        "messages",
        'o [#]':    "output port #",
        'p':        "step over",            // other variations: pr (step and dump registers)
        'print':    "print expression",
        'r':        "dump/set registers",
        'reset':    "reset machine",
        's':        "set options",
        't [#]':    "trace",                // other variations: tr (trace and dump registers)
        'u [#]':    "unassemble",
        'v':        "print version",
        'var':      "assign variable"
    };

    DebuggerX80.STYLE_8080 = 8080;
    DebuggerX80.STYLE_8086 = 8086;

    /*
     * CPU instruction ordinals
     */
    DebuggerX80.INS = {
        NONE:   0,  ACI:    1,  ADC:    2,  ADD:    3,  ADI:    4,  ANA:    5,  ANI:    6,  CALL:   7,
        CC:     8,  CM:     9,  CNC:   10,  CNZ:   11,  CP:    12,  CPE:   13,  CPO:   14,  CZ:    15,
        CMA:   16,  CMC:   17,  CMP:   18,  CPI:   19,  DAA:   20,  DAD:   21,  DCR:   22,  DCX:   23,
        DI:    24,  EI:    25,  HLT:   26,  IN:    27,  INR:   28,  INX:   29,  JMP:   30,  JC:    31,
        JM:    32,  JNC:   33,  JNZ:   34,  JP:    35,  JPE:   36,  JPO:   37,  JZ:    38,  LDA:   39,
        LDAX:  40,  LHLD:  41,  LXI:   42,  MOV:   43,  MVI:   44,  NOP:   45,  ORA:   46,  ORI:   47,
        OUT:   48,  PCHL:  49,  POP:   50,  PUSH:  51,  RAL:   52,  RAR:   53,  RET:   54,  RC:    55,
        RM:    56,  RNC:   57,  RNZ:   58,  RP:    59,  RPE:   60,  RPO:   61,  RZ:    62,  RLC:   63,
        RRC:   64,  RST:   65,  SBB:   66,  SBI:   67,  SHLD:  68,  SPHL:  69,  STA:   70,  STAX:  71,
        STC:   72,  SUB:   73,  SUI:   74,  XCHG:  75,  XRA:   76,  XRI:   77,  XTHL:  78
    };

    /*
     * CPU instruction names (mnemonics), indexed by CPU instruction ordinal (above)
     *
     * If you change the default style, using the "s" command (eg, "s 8086"), then the 8086 table
     * will be used instead.  TODO: Add a "s z80" command for Z80-style mnemonics.
     */
    DebuggerX80.INS_NAMES = [
        "NONE",     "ACI",      "ADC",      "ADD",      "ADI",      "ANA",      "ANI",      "CALL",
        "CC",       "CM",       "CNC",      "CNZ",      "CP",       "CPE",      "CPO",      "CZ",
        "CMA",      "CMC",      "CMP",      "CPI",      "DAA",      "DAD",      "DCR",      "DCX",
        "DI",       "EI",       "HLT",      "IN",       "INR",      "INX",      "JMP",      "JC",
        "JM",       "JNC",      "JNZ",      "JP",       "JPE",      "JPO",      "JZ",       "LDA",
        "LDAX",     "LHLD",     "LXI",      "MOV",      "MVI",      "NOP",      "ORA",      "ORI",
        "OUT",      "PCHL",     "POP",      "PUSH",     "RAL",      "RAR",      "RET",      "RC",
        "RM",       "RNC",      "RNZ",      "RP",       "RPE",      "RPO",      "RZ",       "RLC",
        "RRC",      "RST",      "SBB",      "SBI",      "SHLD",     "SPHL",     "STA",      "STAX",
        "STC",      "SUB",      "SUI",      "XCHG",     "XRA",      "XRI",      "XTHL"
    ];

    DebuggerX80.INS_NAMES_8086 = [
        "NONE",     "ADC",      "ADC",      "ADD",      "ADD",      "AND",      "AND",      "CALL",
        "CALLC",    "CALLS",    "CALLNC",   "CALLNZ",   "CALLNS",   "CALLP",    "CALLNP",   "CALLZ",
        "NOT",      "CMC",      "CMP",      "CMP",      "DAA",      "ADD",      "DEC",      "DEC",
        "CLI",      "STI",      "HLT",      "IN",       "INC",      "INC",      "JMP",      "JC",
        "JS",       "JNC",      "JNZ",      "JNS",      "JP",       "JNP",      "JZ",       "MOV",
        "MOV",      "MOV",      "MOV",      "MOV",      "MOV",      "NOP",      "OR",       "OR",
        "OUT",      "JMP",      "POP",      "PUSH",     "RCL",      "RCR",      "RET",      "RETC",
        "RETS",     "RETNC",    "RETNZ",    "RETNS",    "RETP",     "RETNP",    "RETZ",     "ROL",
        "ROR",      "RST",      "SBB",      "SBB",      "MOV",      "MOV",      "MOV",      "MOV",
        "STC",      "SUB",      "SUB",      "XCHG",     "XOR",      "XOR",      "XCHG"
    ];

    DebuggerX80.REG_B      = 0x00;
    DebuggerX80.REG_C      = 0x01;
    DebuggerX80.REG_D      = 0x02;
    DebuggerX80.REG_E      = 0x03;
    DebuggerX80.REG_H      = 0x04;
    DebuggerX80.REG_L      = 0x05;
    DebuggerX80.REG_M      = 0x06;
    DebuggerX80.REG_A      = 0x07;
    DebuggerX80.REG_BC     = 0x08;
    DebuggerX80.REG_DE     = 0x09;
    DebuggerX80.REG_HL     = 0x0A;
    DebuggerX80.REG_SP     = 0x0B;
    DebuggerX80.REG_PC     = 0x0C;
    DebuggerX80.REG_PS     = 0x0D;
    DebuggerX80.REG_PSW    = 0x0E;         // aka AF if Z80-style mnemonics

    /*
     * NOTE: "PS" is the complete processor status, which includes bits like the Interrupt flag (IF),
     * which is NOT the same as "PSW", which is the low 8 bits of "PS" combined with "A" in the high byte.
     */
    DebuggerX80.REGS = [
        "B", "C", "D", "E", "H", "L", "M", "A", "BC", "DE", "HL", "SP", "PC", "PS", "PSW"
    ];

    /*
     * Operand type descriptor masks and definitions
     */
    DebuggerX80.TYPE_SIZE  = 0x000F;       // size field
    DebuggerX80.TYPE_MODE  = 0x00F0;       // mode field
    DebuggerX80.TYPE_IREG  = 0x0F00;       // implied register field
    DebuggerX80.TYPE_OTHER = 0xF000;       // "other" field

    /*
     * TYPE_SIZE values
     */
    DebuggerX80.TYPE_NONE  = 0x0000;       // (all other TYPE fields ignored)
    DebuggerX80.TYPE_BYTE  = 0x0001;       // byte, regardless of operand size
    DebuggerX80.TYPE_SBYTE = 0x0002;       // byte sign-extended to word
    DebuggerX80.TYPE_WORD  = 0x0003;       // word (16-bit value)

    /*
     * TYPE_MODE values
     */
    DebuggerX80.TYPE_REG   = 0x0010;       // register
    DebuggerX80.TYPE_IMM   = 0x0020;       // immediate data
    DebuggerX80.TYPE_ADDR  = 0x0033;       // immediate (word) address
    DebuggerX80.TYPE_MEM   = 0x0040;       // memory reference
    DebuggerX80.TYPE_INT   = 0x0080;       // interrupt level encoded in instruction (bits 3-5)

    /*
     * TYPE_IREG values, based on the REG_* constants.
     *
     * Note that TYPE_M isn't really a register, just an alternative form of TYPE_HL | TYPE_MEM.
     */
    DebuggerX80.TYPE_A     = (DebuggerX80.REG_A  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_B     = (DebuggerX80.REG_B  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_C     = (DebuggerX80.REG_C  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_D     = (DebuggerX80.REG_D  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_E     = (DebuggerX80.REG_E  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_H     = (DebuggerX80.REG_H  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_L     = (DebuggerX80.REG_L  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE);
    DebuggerX80.TYPE_M     = (DebuggerX80.REG_M  << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_BYTE | DebuggerX80.TYPE_MEM);
    DebuggerX80.TYPE_BC    = (DebuggerX80.REG_BC << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);
    DebuggerX80.TYPE_DE    = (DebuggerX80.REG_DE << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);
    DebuggerX80.TYPE_HL    = (DebuggerX80.REG_HL << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);
    DebuggerX80.TYPE_SP    = (DebuggerX80.REG_SP << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);
    DebuggerX80.TYPE_PC    = (DebuggerX80.REG_PC << 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);
    DebuggerX80.TYPE_PSW   = (DebuggerX80.REG_PSW<< 8 | DebuggerX80.TYPE_REG | DebuggerX80.TYPE_WORD);

    /*
     * TYPE_OTHER bit definitions
     */
    DebuggerX80.TYPE_IN    = 0x1000;       // operand is input
    DebuggerX80.TYPE_OUT   = 0x2000;       // operand is output
    DebuggerX80.TYPE_BOTH  = (DebuggerX80.TYPE_IN | DebuggerX80.TYPE_OUT);
    DebuggerX80.TYPE_OPT   = 0x4000;       // optional operand (ie, normally omitted in 8080 assembly language)
    DebuggerX80.TYPE_UNDOC = 0x8000;       // opcode is an undocumented alternative encoding

    /*
     * The aaOpDescs array is indexed by opcode, and each element is a sub-array (aOpDesc) that describes
     * the corresponding opcode. The sub-elements are as follows:
     *
     *      [0]: {number} of the opcode name (see INS.*)
     *      [1]: {number} containing the destination operand descriptor bit(s), if any
     *      [2]: {number} containing the source operand descriptor bit(s), if any
     *      [3]: {number} containing the occasional third operand descriptor bit(s), if any
     *
     * These sub-elements are all optional. If [0] is not present, the opcode is undefined; if [1] is not
     * present (or contains zero), the opcode has no (or only implied) operands; if [2] is not present, the
     * opcode has only a single operand.  And so on.
     *
     * Additional default rules:
     *
     *      1) If no TYPE_OTHER bits are specified for the first (destination) operand, TYPE_OUT is assumed;
     *      2) If no TYPE_OTHER bits are specified for the second (source) operand, TYPE_IN is assumed;
     *      3) If no size is specified for the second operand, the size is assumed to match the first operand.
     */
    DebuggerX80.aaOpDescs = [
    /* 0x00 */  [DebuggerX80.INS.NOP],
    /* 0x01 */  [DebuggerX80.INS.LXI,   DebuggerX80.TYPE_BC,    DebuggerX80.TYPE_IMM],
    /* 0x02 */  [DebuggerX80.INS.STAX,  DebuggerX80.TYPE_BC   | DebuggerX80.TYPE_MEM, DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT],
    /* 0x03 */  [DebuggerX80.INS.INX,   DebuggerX80.TYPE_BC],
    /* 0x04 */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_B],
    /* 0x05 */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_B],
    /* 0x06 */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_IMM],
    /* 0x07 */  [DebuggerX80.INS.RLC],
    /* 0x08 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x09 */  [DebuggerX80.INS.DAD,   DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_BC],
    /* 0x0A */  [DebuggerX80.INS.LDAX,  DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_BC   | DebuggerX80.TYPE_MEM],
    /* 0x0B */  [DebuggerX80.INS.DCX,   DebuggerX80.TYPE_BC],
    /* 0x0C */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_C],
    /* 0x0D */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_C],
    /* 0x0E */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_IMM],
    /* 0x0F */  [DebuggerX80.INS.RRC],
    /* 0x10 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x11 */  [DebuggerX80.INS.LXI,   DebuggerX80.TYPE_DE,    DebuggerX80.TYPE_IMM],
    /* 0x12 */  [DebuggerX80.INS.STAX,  DebuggerX80.TYPE_DE   | DebuggerX80.TYPE_MEM, DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT],
    /* 0x13 */  [DebuggerX80.INS.INX,   DebuggerX80.TYPE_DE],
    /* 0x14 */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_D],
    /* 0x15 */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_D],
    /* 0x16 */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_IMM],
    /* 0x17 */  [DebuggerX80.INS.RAL],
    /* 0x18 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x19 */  [DebuggerX80.INS.DAD,   DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_DE],
    /* 0x1A */  [DebuggerX80.INS.LDAX,  DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_DE   | DebuggerX80.TYPE_MEM],
    /* 0x1B */  [DebuggerX80.INS.DCX,   DebuggerX80.TYPE_DE],
    /* 0x1C */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_E],
    /* 0x1D */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_E],
    /* 0x1E */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_IMM],
    /* 0x1F */  [DebuggerX80.INS.RAR],
    /* 0x20 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x21 */  [DebuggerX80.INS.LXI,   DebuggerX80.TYPE_HL,    DebuggerX80.TYPE_IMM],
    /* 0x22 */  [DebuggerX80.INS.SHLD,  DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_MEM, DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT],
    /* 0x23 */  [DebuggerX80.INS.INX,   DebuggerX80.TYPE_HL],
    /* 0x24 */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_H],
    /* 0x25 */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_H],
    /* 0x26 */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_IMM],
    /* 0x27 */  [DebuggerX80.INS.DAA],
    /* 0x28 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x29 */  [DebuggerX80.INS.DAD,   DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_HL],
    /* 0x2A */  [DebuggerX80.INS.LHLD,  DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_MEM],
    /* 0x2B */  [DebuggerX80.INS.DCX,   DebuggerX80.TYPE_HL],
    /* 0x2C */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_L],
    /* 0x2D */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_L],
    /* 0x2E */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_IMM],
    /* 0x2F */  [DebuggerX80.INS.CMA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT],
    /* 0x30 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x31 */  [DebuggerX80.INS.LXI,   DebuggerX80.TYPE_SP,    DebuggerX80.TYPE_IMM],
    /* 0x32 */  [DebuggerX80.INS.STA,   DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_MEM, DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT],
    /* 0x33 */  [DebuggerX80.INS.INX,   DebuggerX80.TYPE_SP],
    /* 0x34 */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_M],
    /* 0x35 */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_M],
    /* 0x36 */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_IMM],
    /* 0x37 */  [DebuggerX80.INS.STC],
    /* 0x38 */  [DebuggerX80.INS.NOP,   DebuggerX80.TYPE_UNDOC],
    /* 0x39 */  [DebuggerX80.INS.DAD,   DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_SP],
    /* 0x3A */  [DebuggerX80.INS.LDA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_MEM],
    /* 0x3B */  [DebuggerX80.INS.DCX,   DebuggerX80.TYPE_SP],
    /* 0x3C */  [DebuggerX80.INS.INR,   DebuggerX80.TYPE_A],
    /* 0x3D */  [DebuggerX80.INS.DCR,   DebuggerX80.TYPE_A],
    /* 0x3E */  [DebuggerX80.INS.MVI,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_IMM],
    /* 0x3F */  [DebuggerX80.INS.CMC],
    /* 0x40 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_B],
    /* 0x41 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_C],
    /* 0x42 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_D],
    /* 0x43 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_E],
    /* 0x44 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_H],
    /* 0x45 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_L],
    /* 0x46 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_M],
    /* 0x47 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_B,     DebuggerX80.TYPE_A],
    /* 0x48 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_B],
    /* 0x49 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_C],
    /* 0x4A */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_D],
    /* 0x4B */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_E],
    /* 0x4C */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_H],
    /* 0x4D */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_L],
    /* 0x4E */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_M],
    /* 0x4F */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_C,     DebuggerX80.TYPE_A],
    /* 0x50 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_B],
    /* 0x51 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_C],
    /* 0x52 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_D],
    /* 0x53 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_E],
    /* 0x54 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_H],
    /* 0x55 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_L],
    /* 0x56 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_M],
    /* 0x57 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_D,     DebuggerX80.TYPE_A],
    /* 0x58 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_B],
    /* 0x59 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_C],
    /* 0x5A */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_D],
    /* 0x5B */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_E],
    /* 0x5C */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_H],
    /* 0x5D */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_L],
    /* 0x5E */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_M],
    /* 0x5F */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_E,     DebuggerX80.TYPE_A],
    /* 0x60 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_B],
    /* 0x61 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_C],
    /* 0x62 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_D],
    /* 0x63 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_E],
    /* 0x64 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_H],
    /* 0x65 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_L],
    /* 0x66 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_M],
    /* 0x67 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_H,     DebuggerX80.TYPE_A],
    /* 0x68 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_B],
    /* 0x69 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_C],
    /* 0x6A */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_D],
    /* 0x6B */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_E],
    /* 0x6C */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_H],
    /* 0x6D */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_L],
    /* 0x6E */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_M],
    /* 0x6F */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_L,     DebuggerX80.TYPE_A],
    /* 0x70 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_B],
    /* 0x71 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_C],
    /* 0x72 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_D],
    /* 0x73 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_E],
    /* 0x74 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_H],
    /* 0x75 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_L],
    /* 0x76 */  [DebuggerX80.INS.HLT],
    /* 0x77 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_M,     DebuggerX80.TYPE_A],
    /* 0x78 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_B],
    /* 0x79 */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_C],
    /* 0x7A */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_D],
    /* 0x7B */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_E],
    /* 0x7C */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_H],
    /* 0x7D */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_L],
    /* 0x7E */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_M],
    /* 0x7F */  [DebuggerX80.INS.MOV,   DebuggerX80.TYPE_A,     DebuggerX80.TYPE_A],
    /* 0x80 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0x81 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0x82 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0x83 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0x84 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0x85 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0x86 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0x87 */  [DebuggerX80.INS.ADD,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0x88 */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0x89 */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0x8A */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0x8B */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0x8C */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0x8D */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0x8E */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0x8F */  [DebuggerX80.INS.ADC,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0x90 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0x91 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0x92 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0x93 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0x94 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0x95 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0x96 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0x97 */  [DebuggerX80.INS.SUB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0x98 */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0x99 */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0x9A */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0x9B */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0x9C */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0x9D */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0x9E */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0x9F */  [DebuggerX80.INS.SBB,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0xA0 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0xA1 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0xA2 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0xA3 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0xA4 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0xA5 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0xA6 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0xA7 */  [DebuggerX80.INS.ANA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0xA8 */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0xA9 */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0xAA */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0xAB */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0xAC */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0xAD */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0xAE */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0xAF */  [DebuggerX80.INS.XRA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0xB0 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0xB1 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0xB2 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0xB3 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0xB4 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0xB5 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0xB6 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0xB7 */  [DebuggerX80.INS.ORA,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0xB8 */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_B],
    /* 0xB9 */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_C],
    /* 0xBA */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_D],
    /* 0xBB */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_E],
    /* 0xBC */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_H],
    /* 0xBD */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_L],
    /* 0xBE */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_M],
    /* 0xBF */  [DebuggerX80.INS.CMP,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_A],
    /* 0xC0 */  [DebuggerX80.INS.RNZ],
    /* 0xC1 */  [DebuggerX80.INS.POP,   DebuggerX80.TYPE_BC],
    /* 0xC2 */  [DebuggerX80.INS.JNZ,   DebuggerX80.TYPE_ADDR],
    /* 0xC3 */  [DebuggerX80.INS.JMP,   DebuggerX80.TYPE_ADDR],
    /* 0xC4 */  [DebuggerX80.INS.CNZ,   DebuggerX80.TYPE_ADDR],
    /* 0xC5 */  [DebuggerX80.INS.PUSH,  DebuggerX80.TYPE_BC],
    /* 0xC6 */  [DebuggerX80.INS.ADI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xC7 */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xC8 */  [DebuggerX80.INS.RZ],
    /* 0xC9 */  [DebuggerX80.INS.RET],
    /* 0xCA */  [DebuggerX80.INS.JZ,    DebuggerX80.TYPE_ADDR],
    /* 0xCB */  [DebuggerX80.INS.JMP,   DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_UNDOC],
    /* 0xCC */  [DebuggerX80.INS.CZ,    DebuggerX80.TYPE_ADDR],
    /* 0xCD */  [DebuggerX80.INS.CALL,  DebuggerX80.TYPE_ADDR],
    /* 0xCE */  [DebuggerX80.INS.ACI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xCF */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xD0 */  [DebuggerX80.INS.RNC],
    /* 0xD1 */  [DebuggerX80.INS.POP,   DebuggerX80.TYPE_DE],
    /* 0xD2 */  [DebuggerX80.INS.JNC,   DebuggerX80.TYPE_ADDR],
    /* 0xD3 */  [DebuggerX80.INS.OUT,   DebuggerX80.TYPE_IMM  | DebuggerX80.TYPE_BYTE,DebuggerX80.TYPE_A   | DebuggerX80.TYPE_OPT],
    /* 0xD4 */  [DebuggerX80.INS.CNC,   DebuggerX80.TYPE_ADDR],
    /* 0xD5 */  [DebuggerX80.INS.PUSH,  DebuggerX80.TYPE_DE],
    /* 0xD6 */  [DebuggerX80.INS.SUI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xD7 */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xD8 */  [DebuggerX80.INS.RC],
    /* 0xD9 */  [DebuggerX80.INS.RET,   DebuggerX80.TYPE_UNDOC],
    /* 0xDA */  [DebuggerX80.INS.JC,    DebuggerX80.TYPE_ADDR],
    /* 0xDB */  [DebuggerX80.INS.IN,    DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xDC */  [DebuggerX80.INS.CC,    DebuggerX80.TYPE_ADDR],
    /* 0xDD */  [DebuggerX80.INS.CALL,  DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_UNDOC],
    /* 0xDE */  [DebuggerX80.INS.SBI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xDF */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xE0 */  [DebuggerX80.INS.RPO],
    /* 0xE1 */  [DebuggerX80.INS.POP,   DebuggerX80.TYPE_HL],
    /* 0xE2 */  [DebuggerX80.INS.JPO,   DebuggerX80.TYPE_ADDR],
    /* 0xE3 */  [DebuggerX80.INS.XTHL,  DebuggerX80.TYPE_SP   | DebuggerX80.TYPE_MEM| DebuggerX80.TYPE_OPT,  DebuggerX80.TYPE_HL | DebuggerX80.TYPE_OPT],
    /* 0xE4 */  [DebuggerX80.INS.CPO,   DebuggerX80.TYPE_ADDR],
    /* 0xE5 */  [DebuggerX80.INS.PUSH,  DebuggerX80.TYPE_HL],
    /* 0xE6 */  [DebuggerX80.INS.ANI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xE7 */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xE8 */  [DebuggerX80.INS.RPE],
    /* 0xE9 */  [DebuggerX80.INS.PCHL,  DebuggerX80.TYPE_HL],
    /* 0xEA */  [DebuggerX80.INS.JPE,   DebuggerX80.TYPE_ADDR],
    /* 0xEB */  [DebuggerX80.INS.XCHG,  DebuggerX80.TYPE_HL   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_DE  | DebuggerX80.TYPE_OPT],
    /* 0xEC */  [DebuggerX80.INS.CPE,   DebuggerX80.TYPE_ADDR],
    /* 0xED */  [DebuggerX80.INS.CALL,  DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_UNDOC],
    /* 0xEE */  [DebuggerX80.INS.XRI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xEF */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xF0 */  [DebuggerX80.INS.RP],
    /* 0xF1 */  [DebuggerX80.INS.POP,   DebuggerX80.TYPE_PSW],
    /* 0xF2 */  [DebuggerX80.INS.JP,    DebuggerX80.TYPE_ADDR],
    /* 0xF3 */  [DebuggerX80.INS.DI],
    /* 0xF4 */  [DebuggerX80.INS.CP,    DebuggerX80.TYPE_ADDR],
    /* 0xF5 */  [DebuggerX80.INS.PUSH,  DebuggerX80.TYPE_PSW],
    /* 0xF6 */  [DebuggerX80.INS.ORI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xF7 */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT],
    /* 0xF8 */  [DebuggerX80.INS.RM],
    /* 0xF9 */  [DebuggerX80.INS.SPHL,  DebuggerX80.TYPE_SP   | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_HL  | DebuggerX80.TYPE_OPT],
    /* 0xFA */  [DebuggerX80.INS.JM,    DebuggerX80.TYPE_ADDR],
    /* 0xFB */  [DebuggerX80.INS.EI],
    /* 0xFC */  [DebuggerX80.INS.CM,    DebuggerX80.TYPE_ADDR],
    /* 0xFD */  [DebuggerX80.INS.CALL,  DebuggerX80.TYPE_ADDR | DebuggerX80.TYPE_UNDOC],
    /* 0xFE */  [DebuggerX80.INS.CPI,   DebuggerX80.TYPE_A    | DebuggerX80.TYPE_OPT, DebuggerX80.TYPE_IMM | DebuggerX80.TYPE_BYTE],
    /* 0xFF */  [DebuggerX80.INS.RST,   DebuggerX80.TYPE_INT]
    ];

    DebuggerX80.HISTORY_LIMIT = DEBUG? 100000 : 1000;

    /*
     * Initialize every Debugger module on the page (as IF there's ever going to be more than one ;-))
     */
    Web.onInit(DebuggerX80.init);

}   // endif DEBUGGER

if (typeof module !== "undefined") module.exports = DebuggerX80;
