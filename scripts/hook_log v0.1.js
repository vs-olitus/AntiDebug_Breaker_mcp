// ==UserScript==
// @name         hook_log v0.1
// @namespace    https://github.com/0xsdeo/Hook_JS
// @version      2024-12-02
// @description  通过冻结console对象来禁止js重写log方法
// @author       0xsdeo
// @match        http://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    Object.freeze(console);
})();