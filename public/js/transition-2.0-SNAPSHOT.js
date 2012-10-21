/*jslint browser: true, maxerr: 50, indent: 2, nomen: false, regexp: false, newcap:false */
/*global window, jQuery, _, Backbone, console */
"use strict";

/********************************************************************************
 * Transition.js
 * Version: 2.0-SNAPSHOT
 ********************************************************************************/
(function () {
  var root        = this, 
    Transition  = {
      Log:       {
        Levels: { 
          TRACE: 99,
          DEBUG: 80,
          INFO:  60,
          WARN:  40,
          ERROR: 20,
          FATAL: 10
        }
      },
      Views:     {},
      Models:    {},
      Templates: {
        Runner: {}
      },
      views: {},
      models: {}
    },
    Views       = Transition.Views,
    Models      = Transition.Models,
    Templates   = Transition.Templates,
    mainFrame   = {
      document: this.parent.frames.main
    }, 
    runnerFrame = {
      document: this.parent.frames.test,
      $:        this.parent.frames.test && this.parent.frames.test.$
    },
    $ = this.parent.frames.test ? this.parent.frames.test.$ : jQuery,
    tmpl,
    addView,
    Settings,
    TestState,
    TestStates,
    Test,
    LogEntry,
    LogEntries,
    TestSuite,
    SuiteRunner,
    LogEntryView,
    StateReport,
    TestRunner,
    Log = Transition.Log,
    models = Transition.models;

  root.Transition = Transition;
  Transition.$    = root.jQuery;
  if (!Transition.$) {
    throw 'Error: jQuery not found.';
  }

  /********************************************************************************
   * Templaates and caching.
   *
   ********************************************************************************/
  Transition.tmplCache = {};
  Transition.tmpl = tmpl = function (tmplId, data) {
    var tmpl = Transition.tmplCache[tmplId], tmplElt;
    if (!tmpl) {
      tmplElt = $('#' + tmplId);
      if (tmplElt.length === 0) {
        throw 'Error: template for id ' + tmplId + ' not found!';
      }
      tmpl = Transition.tmplCache[tmplId] = _.template(tmplElt.html());
    }
    return tmpl(data);
  };

  /********************************************************************************
   * Models
   *
   ********************************************************************************/
  Models.Settings = Settings = Backbone.Model.extend({
    defaults: {
      perStateTimeout: 10 * 1000,
      testTimeout:     30 * 1000,
      // NB: hook this into the UI
      maxTransitions:       20,
      maxAttemptsPerState:  50,
      // NB: hook this into the UI
      pollTimeout:     250,
      // NB: hook this into the UI
      logLevel:        Log.Levels.TRACE
      //logLevel:        Log.Levels.INFO
    }
  });

  Models.TestState = TestState = Backbone.Model.extend({
    defaults: {
      name:        '**no state name**',
      onEnter:     function () {
        throw 'no onEnter implemented!';
      },
      attrs:       {start: false, success: false, failure: false},
      transitions: {}
    },

    initialize: function (attributes) {
      var name = attributes.name;
      if (!attributes.name) {
        throw 'Error: TestState must have a name!';
      }
    }
  });

  Models.TestStates = TestStates = Backbone.Collection.extend({
    model: TestState,

    first: function () {
      return this.models[0];
    },

    last: function () {
      return this.models[this.models.length - 1];
    }

  });

  Models.Test = Test = Backbone.Model.extend({
    defaults: {
      name:         '**no test name**',
      isRunning: false
    },

    initialize: function (attributes) {
      var firstState, lastState, transitions;
      this.set('name', attributes.name || '**no test name**');
      this.set('initialize', attributes.initialize || Transition.noop);
      this.set('states', new TestStates());
      this.get('states').reset(attributes.states);

      _.each(this.get('states').models, function (state) {
        if (state.get('attrs').start) {
          if (this.startState) {
            throw "Error: multiple start states in: " + this.get('name');
          }
          this.startState = state;
        }

        if (state.get('attrs').success) {
          if (this.successState) {
            throw "Error: multiple success states in: " + this.get('name');
          }
          this.successState = state;
        }
      });

      if (!this.get('states').first()) {
        this.get('states').add(new TestState({
          name:    'start',
          onEnter: Transition.noop,
          attrs:   {
            start: true, 
            success: false,
            failure: false
          },
          transitions: transitions
        }));
        this.startState = this.get('states').first();
      }

      if (!this.startState) {
        firstState = this.get('states').first();
        transitions = {};
        transitions[firstState.get('name')] = {};
        transitions[firstState.get('name')].to = firstState.get('name');
        transitions[firstState.get('name')].pred = Transition.constantly_(true);
        this.startState = new TestState({
          name:    'start',
          onEnter: Transition.noop,
          attrs:   {
            start: true, 
            success: false,
            failure: false
          },
          transitions: transitions
        });
        this.get('states').add(this.startState);
      }

      if (!this.successState) {
        this.successState = new TestState({
          name:    'success',
          onEnter: Transition.noop,
          attrs:   {
            start: true, 
            success: true,
          failure: false
          },
          transitions: {}
        });
        this.get('states').add(this.successState);
      }

      // NB: validate the graph: that there are no unreachable states

      this.set('currentState', this.startState);
    },

    labelClass: function () {
      if (this.get('isRunning')) {
        return 'label-success';
      }
      return '';
    },

    getState: function (name) {
      var res;
      _.each(this.get('states').models, function (st) {
        if (st.get('name') === name) {
          res = st;
        }
      });
      return res;
    }
  });

  Models.TestSuite = TestSuite = Backbone.Collection.extend({
    model: Test
  });

  Models.SuiteRunner = SuiteRunner = Backbone.Model.extend({
    defaults: {
      currentTest: new Test({})
    },

    initialize: function (ourModels, options) {
      models.suite.on('add', this.trackCurrentTest, this);
      this.set('startTime', new Date());
    },

    trackCurrentTest: function (test) {
      console.log('trackCurrentTest: %o', test);
      this.set('currentTest', test);
      models.suite.off('add', this.trackCurrentTest, this);
    },

    elapsedTime: function () {
      return (new Date()).getTime() - this.get('startTime').getTime();
    }

  });

  Models.LogEntry = LogEntry = Backbone.Model.extend({
    defaults: {
      level:       Transition.Log.Levels.INFO,
      test:        null,
      testState:   null,
      timestamp:   '*test state*',
      repeatCount: 1,
      message:     '*message*'
    },

    initialize: function (attributes) {
      this.set('timestamp', new Date());
      this.set('test',      models.suiteRunner.get('currentTest'));
      this.set('testState', models.suiteRunner.get('currentTest').get('currentState'));
    },

    countRepeat: function () {
      this.set('timestamp', new Date());
      this.set('repeatCount', 1 + this.get('repeatCount'));
    },

    classForLevel: function () {
      if (this.get('labelClass')) {
        return this.get('labelClass');
      }

      if (this.get('level') >= Log.Levels.DEBUG) {
        return '';
      }
      if (this.get('level') >= Log.Levels.INFO) {
        return 'label-info';
      }
      if (this.get('level') >= Log.Levels.WARN) {
        return 'label-warning';
      }
      // ERROR and FATAL
      return 'label-important';
    }

  });

  Models.LogEntries = LogEntries = Backbone.Collection.extend({
    model: LogEntry,
    first: function () {
      if (this.models.length > 0) {
        return this.models[0];
      }
      return null;
    }
  });

  Models.StateReport = StateReport = Backbone.Model.extend({
    defaults: {
      startTime: null,
      endTime:   null,
      state:     null,
      passed:    null,
      checks:    1
    },

    initialize: function (attributes) {
      this.set('state', attributes.state);
      this.set('startTime', new Date());
    },

    elapsedTime: function () {
      return (new Date()).getTime() - this.get('startTime').getTime();
    }

  });

  Models.TestRunner = TestRunner = Backbone.Model.extend({
    initialize: function (attributes) {
      this.set('test',  attributes.test);
      this.set('state', attributes.test.getState('start'));
    },

    start: function () {
      this.set('isRunning', true);
      this.set('startTime', new Date());
      this.set('stateReport', new StateReport({
        state: this.get('state')
      }));
      try {
        this.get('test').get('initialize').call(this.get('state'));
        this.get('state').get('onEnter').call(this.get('state'));
      }
      catch (e) {
        console.error(e);
        this.set('error', e);
        Log.error(e);
      }
    },

    transition: function () {
      var dests = [], 
          test  = this.get('test'),
          state = this.get('state');
      // if any of the exit predicates pass...
      _.each(state.get('transitions'), function (tr) {
        if (tr.pred.call(test, state, tr)) {
          dests.push(tr);
        }
      });

      if (dests.length > 1) {
        this.set('passed', false);
        this.set('error', "Error: more than 1 transition out of " + this.get('state').get('name') + " :" + JSON.stringify(dests));
        Log.error();
      }

      if (dests.length === 1) {
        state.set('endTime', new Date());
        Log.info("Transitioning from " + state.get('name') + " to " + dests[0].to);
        state = test.getState(dests[0].to);
        this.set('state', state);
        state.get('onEnter').call(state, dests[0]);

        if (state.get('attrs').success || state.get('attrs').failure) {
          this.set('isDone', true);
          this.set('elapsedTime', this.elapsedTime());
          this.set('isRunning', false);
        }

        return true;
      }

      //Log.trace("No transition from " + state.get('name') + " yet..." + this.get('stateReport').elapsedTime() + "/" + this.elapsedTime());
      Log.trace("No transition from " + state.get('name') + " yet...");

      return false;
    },

    elapsedTime: function () {
      return (new Date()).getTime() - this.get('startTime').getTime();
    }

  });

  /********************************************************************************
   * Views
   *
   ********************************************************************************/
  Views.Navbar = Backbone.View.extend({
    templateId: 'navbar-tmpl',

    events: {
      'click .settings': 'showSettings',
      'click a.test':    'testSelected'
    },

    initialize: function () {
      this.constructor.__super__.initialize.apply(this, []);
      _.bindAll(this, 'showSettings');
      models.suite.on('all', this.render, this);
    },

    remove: function () {
      models.suite.off('all', this.render);
      this.$el.remove();
    },

    showSettings: function () {
      console.log('show the settings dialog');
      Transition.views.settings.display();
    },

    testSelected: function (evt) {
      evt.preventDefault();
      var dest = $(evt.target).attr('href');
      console.log('testSelected: %o => %o', $(evt.target), dest);
      Transition.router.navigate(dest, {trigger: true});
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, {suite: models.suite}));
      this.$('.dropdown-toggle').dropdown();
      return this;
    }
  });

  Views.Controls = Backbone.View.extend({
    templateId: 'transition-runner-controls-tmpl',

    events: {
      'click button[name=run]':      'runClicked',
      'click button[name=stop]':     'stopClicked',
      'click button[name=start]':    'startClicked',
      'click button[name=step]':     'stepClicked',
      'click button[name=continue]': 'continueClicked',
      'click button[name=reload]':   'reloadClicked',
      'click button[name=clear]':    'clearClicked'
    },

    initialize: function () {
      this.constructor.__super__.initialize.apply(this, []);
      _.bindAll(this, 'runClicked');
      _.bindAll(this, 'stopClicked');
      _.bindAll(this, 'stepClicked');
      _.bindAll(this, 'continueClicked');
      _.bindAll(this, 'reloadClicked');
      _.bindAll(this, 'clearClicked');
    },

    runClicked: function () {
      Transition.runSuite();
    },

    startClicked: function () {
      Transition.runTest();
    },

    stopClicked: function () {
      Transition.stop();
    },

    stepClicked: function () {
      Transition.step();
    },

    continueClicked: function () {
      Transition.cont();
    },

    reloadClicked: function () {
      console.log('reloadClicked');
    },

    clearClicked: function (evt) {
      console.log('clearClicked');
      models.logEntries.reset([]);
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, {}));
      return this;
    }
  });

  Views.SuiteProgressBar = Backbone.View.extend({
    templateId: 'transition-runner-progress-bar-tmpl',

    events: {
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, {}));
      $('.dropdown-toggle').dropdown();
      return this;
    }
  });

  Views.Settings = Backbone.View.extend({
    templateId: 'transition-runner-settings-modal-tmpl',

    events: {
      'click button':               'closeClicked',
      'change input#test-timeout':  'testTimeoutUpdated',
      'change input#state-timeout': 'stateTimeoutUpdated'
    },

    initialize: function (options) {
      this.constructor.__super__.initialize.apply(this, []);
      _.bindAll(this, 'closeClicked');
      _.bindAll(this, 'display');
      _.bindAll(this, 'testTimeoutUpdated');
      _.bindAll(this, 'stateTimeoutUpdated');
      models.settings.on('change', this.render, this);
    },

    remove: function () {
      models.settings.off('change', this.render, this);
      this.$el.remove();
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, models.settings));
      this.$dialogEl = $('#transition-runner-settings-modal-container');
      this.$dialogEl.html(this.el);
      this.$dialogEl.dialog({
        modal:     true,
        autoOpen:  false,
        title:     'Settings',
        width: 600
      });
      this.$dialogEl.parent().find('.ui-dialog-titlebar').css('display', 'none');
      this.delegateEvents();
    },

    closeClicked: function () {
      console.log('closeClicked');
      this.$dialogEl.dialog('close');
    },

    testTimeoutUpdated: function (evt) {
      models.settings.set('testTimeout', $(evt.target).val());
      return true;
    },

    stateTimeoutUpdated: function (evt) {
      models.settings.set('perStateTimeout', $(evt.target).val());
      return true;
    },

    display: function () {
      this.$dialogEl.dialog('open');
    }

  });

  Views.CurrentTestState = Backbone.View.extend({
    templateId: 'transition-runner-current-test-state-tmpl',

    events: {
    },

    initialize: function (options) {
      this.constructor.__super__.initialize.apply(this, []);
      models.suiteRunner.on('all', this.render, this);
      models.settings.on('change', this.render, this);
    },

    remove: function () {
      models.suiteRunner.off('all', this.render, this);
      models.settings.off('change', this.render, this);
      this.$el.remove();
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, models.suiteRunner.get('currentTest')));
    }
  });

  Views.LogEntryView = LogEntryView = Backbone.View.extend({
    templateId: 'transition-runner-log-entry-tmpl',

    initialize: function (options) {
      this.constructor.__super__.initialize.apply(this, []);
      this.logEntry = options.logEntry;
      this.logEntry.on('change', this.render, this);
    },

    remove: function () {
      this.logEntry.off('change', this.render, this);
      this.$el.remove();
    },

    render: function () {
      this.$el.html(tmpl(this.templateId, this.logEntry));
      return this;
    }

  });

  Views.LogViewer = Backbone.View.extend({
    tagName: 'div',

    entryViews: {},

    initialize: function (options) {
      this.constructor.__super__.initialize.apply(this, []);
      models.logEntries.on('reset',  this.render,         this);
      models.logEntries.on('add',    this.addLogEntry,    this);
      models.logEntries.on('remove', this.removeLogEntry, this);
    },

    removeLogEntry: function (logEntry) {
      console.log('LogViewer.removeLogEntry');
    },

    addLogEntry: function (logEntry) {
      // NB: don't push it on if it's the same as the one at the top of the
      // list, just increment it's repeat count
      var entryView = new LogEntryView({logEntry: logEntry});
      if (logEntry.get('level') > models.settings.get('logLevel')) {
        return;
      }
      entryView.render();
      this.entryViews[logEntry.cid] = entryView;
      this.$el.prepend(entryView.$el);
    },

    render: function () {
      _.each(this.entryViews, function (entryView, cid) {
        entryView.remove();
      });
      models.logEntries.each(this.addLogEntry, this);
    }

  });


  /********************************************************************************
   * View Helpers
   *
   ********************************************************************************/
  Transition.addView = addView = function (name, clazz, appendToSelector, cdata, rdata) {
    var view = new clazz(cdata);
    Transition.views[name] = view;
    view.render(rdata);
    view.$el.appendTo(appendToSelector);
    return view;
  };

  Transition.pollFn = function () {
    // stop if we've exceeded the testTimeout
    // or if we've extend the maxTransitions
    // or if we've extend the maxAttemptsPerState
    if (Transition.testRunner.get('isDone')) {
      Log.info('Test completed!');
      return;
    }
    Transition.testRunner.transition();
    Transition.pollTimeoutId = setTimeout(
        Transition.pollFn,
        models.settings.get('pollTimeout')
    );
  };

  Transition.runSuite = function () {
    console.log('Transition.runSuite: start the sutie at the first non-pending test, at it\'s start state');
    var tests    = models.suite.models, 
        currTest = tests.shift();

    Transition.stopSuite = false;
    models.suiteRunner.set('currentTest', currTest);
    models.suiteRunner.set('startTime', new Date());
    Transition.runTest();

    Transition.suitePollFn = function () {
      if(Transition.stopSuite) {
        Log.info('Suite: halted.');
        return;
      }

      if (models.suiteRunner.elapsedTime() >= models.settings.get('testTimeout') ) {
        Log.fatal('Suite: entire suite timed out at ' + (models.settings.get('testTimeout')/1000) +' seconds');
        Transition.stop();
        return;
      }

      if (Transition.testRunner.get('isDone')) {
        clearTimeout(Transition.pollTimeoutId);
        Log.info('Suite: current test is done');
        currTest = tests.shift();
        if (currTest) {
          models.suiteRunner.set('currentTest', currTest);
          Transition.runTest();
          Transition.suitePollTimeoutId = setTimeout(Transition.suitePollFn, models.settings.get('pollTimeout'));
          return;
        }
      }
      Transition.suitePollTimeoutId = setTimeout(Transition.suitePollFn, models.settings.get('pollTimeout'));
    };

    Transition.suitePollTimeoutId = setTimeout(Transition.suitePollFn, models.settings.get('pollTimeout'));
  };

  Transition.runTest = function () {
    var test = models.suiteRunner.get('currentTest');
    Transition.testRunner = new TestRunner({
      test: test
    });
    // NB: set up the observers for the UI here...
    // it might be simplest (from an event observation
    // model) if we have 1 runner that we keep re-using.
    Log.info(test.get('name') + ' start!');
    Transition.testRunner.start();
    test.set('currentState', test.getState('start'));
    console.log('startClicked: start test at it\'s start state: %o', test.get('name'));
    Transition.pollTimeoutId = setTimeout(
        Transition.pollFn,
        models.settings.get('pollTimeout')
    );
  };

  Transition.stop = function () {
    console.log('Transition.stop');
    clearTimeout(Transition.pollTimeoutId);
    Transition.pollTimeoutId = null;
    Transition.stopSuite = true;
  };

  Transition.step = function () {
    console.log('Transition.step');
  };

  Transition.cont = function () {
    console.log('Transition.cont');
  };

  /********************************************************************************
   * Test Suite Management and Helpers
   *
   ********************************************************************************/
  Transition.newState = function () {
    var args = [].slice.call(arguments),
        stateName = args.shift(),
        onEnter   = args.shift(),
        attrs     = args.shift(),
        state = new TestState({
      name:        stateName,
      onEnter:     onEnter,
      attrs:       attrs,
      transitions: args
    });
    return state;
  };

  Transition.addTest = function (options) {
    try {
      var test = new Test({
        name:       options.name,
        states:     options.states,
        initialize: options.initialize
      });
      models.suite.add(test);
      return this;
    }
    catch (e) {
      console.log(e.get_stack());
      console.error(e);
      Log.fatal("Error registering test: " + options.name);
    }
  };

  Transition.noop = function () {
  };

  Transition.constantly_ = function (val) {
    return function () {
      return val;
    };
  };

  Transition.navigateTo = function (dest) {
    parent.frames.main.document.location = dest;
  };

  Transition.navigateTo_ = function (dest) {
    return function () {
      Transition.navigateTo(dest);
    };
  };

  Transition.find = function (selector) {
    return $(parent.frames.main.document).find(selector);
  };

  Transition.elementExists = function (selector) {
    var result = Transition.find(selector);
    return result.length > 0;
  };

  Transition.elementExists_ = function (selector) {
    return function () {
      return Transition.elementExists(selector);
    };
  };

  Transition.Log.newEntry = function (level, args) {
    var entry = new LogEntry({
      level:       level,
      testName:    models.suiteRunner.get('currentTest'),
      testState:   models.suiteRunner.get('currentTest').get('currentState'),
      timestamp:   '*test state*',
      repeatCount: 1,
      message:     _.reduce(args, function (acc, str) {
          return acc + str;
        },
        ''
      )
    });

    if (models.logEntries.models.length > 1 &&
        models.logEntries.first().get('message') === entry.get('message')) {
      models.logEntries.first().countRepeat();
      return models.logEntries.first();
    }

    models.logEntries.unshift(entry);
    return entry;
  };

  Transition.Log.trace = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.TRACE, arguments);
  };

  Transition.Log.debug = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.DEBUG, arguments);
  };

  Transition.Log.info = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.INFO, arguments);
  };

  Transition.Log.warn = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.WARN, arguments);
  };

  Transition.Log.error = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.ERROR, arguments);
  };

  Transition.Log.fatal = function () {
    Transition.Log.newEntry.call(Transition, Log.Levels.FATAL, arguments);
  };

  /********************************************************************************
   * Router
   *
   ********************************************************************************/
  Transition.Router = Backbone.Router.extend({
    routes: {
      "test/:name":     "showTest",
      "*any":           "main"
    },

    showTest: function (testName) {
      var currTest;

      if (models.suite.length < 1) {
        return;
      }

      currTest = models.suite.find(function (elt) {
        return elt.get('name') === testName;
      });

      models.suiteRunner.set('currentTest', currTest);
      console.log('route[showTest(' + testName + ')]');
    },

    main: function () {
      // set the default selected test here?
    }

  });

  models.suite       = new TestSuite();
  models.settings    = new Models.Settings();
  models.suiteRunner = new SuiteRunner();
  models.logEntries  = new LogEntries();

  /********************************************************************************
   * Construct the Runner
   *
   ********************************************************************************/
  Transition.buildRunner = function () {
    Transition.router  = new Transition.Router();
    Log.info('router initialized');
    addView('navBar',           Views.Navbar,           '#transition-runner-menubar');
    addView('progressBar',      Views.SuiteProgressBar, '#transition-runner-progress-bar');
    addView('controls',         Views.Controls,         '#transition-runner-controls');
    addView('settings',         Views.Settings,         '#transition-runner-settings-modal-container');
    addView('currentTestState', Views.CurrentTestState, '#transition-runner-current-test-state');
    addView('logViewer',        Views.LogViewer,        '#transition-runner-log-viewer');
    Log.info('views initialized');
    Backbone.history.start();
    Log.info('runner initialization completed.');
  };


  //Transition.buildRunner();
}.call(this));
