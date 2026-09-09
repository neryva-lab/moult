# Command host example

This example is a small command-oriented host. It owns a command resource through each plugin
generation's public `Scope`, then exercises failed and successful replacement. It intentionally
shares no application module with the worker host.
