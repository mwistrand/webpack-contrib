"use strict";
(function main() {
    var app = document.getElementById('app');
    var div = document.createElement('div');
    /** @preserve dojoBuildBridgeCache 'foo.block' **/
    window.__dojoBuildBridge('foo.block', ['a']).then(function (result) {
        div.innerHTML = result;
    });
    app.appendChild(div);
	window.test = {
		rendering: false
	}
})();
//# sourceMappingURL=main.0123456789abcdefghij.bundle.js.map
