/**
 * Implementation of the root and tab actors for the Chromium debugging server.
 */

const request = require("sdk/request");

const task = require("util/task");

const {emit} = require("devtools/sdk/event/core"); // Needs to share a loader with protocol.js, boo.
const protocol = require("devtools/server/protocol");
const {Actor, ActorClass, method, Arg, Option, RetVal} = protocol;
const {asyncMethod} = require("util/protocol-extra");

const {ChromiumConsoleActor} = require("chromium/webconsole");

protocol.types.addDictType("chromium_tablist", {
  selected: "number",
  tabs: "array:chromium_tab"
});

function requestTabs(url) {
  return new Promise((resolve, reject) => {
    let tabsRequest = request.Request({
      url: url,
      onComplete: function(response) {
        resolve(response.json);
      }
    });
    tabsRequest.get();
  });
}

var ChromiumRootActor = ActorClass({
  typeName: "chromium_root",

  initialize: function(conn, url) {
    this.actorID = "root";
    Actor.prototype.initialize.call(this, conn);
    this.tabActors = new Map();
  },

  sayHello: function() {
    this.conn.send({
      from: this.actorID,
      applicationType: "browser",
      // There's work to do here.
      traits: {
        sources: false,
        editOuterHTML: false,
        highlightable: false,
        urlToImageDataResolver: false,
        networkMonitor: false,
        storageInspector: false,
        storageInspectorReadOnly: false,
        conditionalBreakpoints: false
      }
    });
  },

  listTabs: asyncMethod(function*() {
    let jsonTabs = yield requestTabs(this.conn.url + "/json");

    let response = {
      tabs: []
    };

    for (let json of jsonTabs) {
      if (!json.webSocketDebuggerUrl) {
        continue;
      }
      response.tabs.push(this.tabActorFor(json));
      if (!("selected" in response) && json.type == "page") {
        response.selected = response.tabs.length - 1;
      }
    }

    return response;
  }, {
    request: {},
    response: RetVal("chromium_tablist")
  }),

  tabActorFor: function(json) {
    if (this.tabActors.has(json.id)) {
      return this.tabActors.get(json.id);
    }

    let actor = ChromiumTabActor(this.conn, json);
    this.tabActors.set(json.id, actor);
    return actor;
  }
});

exports.ChromiumRootActor = ChromiumRootActor;

var ChromiumTabActor = ActorClass({
  typeName: "chromium_tab",

  events: {
    "tab-navigated": {
      type: "tabNavigated",
      url: Arg(0, "string"),
      state: Arg(1, "string"),
      nativeConsoleAPI: true, // I dont't like that this is piggybacking here.
    }
  },

  initialize: function(conn, json) {
    Actor.prototype.initialize.call(this, conn);
    this.json = json;
    const rpc = require("chromium/rpc");
    this.rpc = rpc.TabConnection(json);

    this.rpc.on("Page.frameStartedLoading", this.onFrameStartedLoading.bind(this));
    this.rpc.on("Page.frameNavigated", this.onPageNavigated.bind(this));

    this.consoleActorID = conn.manageLazy(this, conn.allocID(), () => {
      return ChromiumConsoleActor(this);
    });
  },

  form: function(detail) {
    return {
      actor: this.actorID,
      title: this.json.title,
      url: this.json.url,
      consoleActor: this.consoleActorID
    }
  },

  onFrameStartedLoading: task.async(function*(params) {
    if (params.frameId != this.rootFrameId) {
      return;
    }

    emit(this, "tab-navigated", this.currentURL, "start");
  }),

  onPageNavigated: function(params) {
    // XXX: We only send tabNavigated for toplevel frame loads.
    // Which is a weakness of the fxdevtools protocol, look in to that.
    if (params.frame.parentId) {
      return;
    }

    this.rootFrameId = params.frame.id;
    this.currentURL = params.frame.url;

    emit(this, "tab-navigated", params.frame.url, "stop");
  },

  /**
   * Subscribe to tab navigation events.
   */
  attach: asyncMethod(function*() {
    // Before we go crazy getting notifications, let's make sure we know
    // our root frame ID.
    let resources = yield this.rpc.request("Page.getResourceTree");
    this.rootFrameId = resources.frameTree.frame.id;
    this.currentURL = resources.frameTree.frame.url;
    yield this.rpc.request("Page.enable");
  }, {
    request: {},
    response: {}
  }),

  /**
   * Unsubscribe from tab navigation events.
   */
  detach: asyncMethod(function*() {
    yield this.rpc.request("Page.disable");
  }, {
    request: {},
    response: {}
  })
});