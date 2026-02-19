# Todo

Core reliability and usability

* Fix garbled PTYs after refresh
* Add proper scrollback support
* Add scroll to bottom button and auto-scroll toggle
* Show PTY window title dynamically
* Tighten UI spacing, alignment, and visual hierarchy
* Improve session naming defaults
* Improve session switching speed

Launch and session awareness

* Add quick launch panel
* Allow additional agent args in launch panel
* Add explicit input required session status
* Show clear running, idle, and waiting states

Projects

* Promote pinned directories to projects
* Add pin project action
* Auto-detect candidate projects from session directories
* Auto-pin first detected project
* Persist project settings
* Add default agent args per project
* Remember last used project settings
* Store project metadata cleanly

Session organization and layouts

* Connect to multiple tmux sessions
* Hide and show sessions
* Add preset layouts (focus, grid, stage)
* Allow assigning sessions to layout slots
* Persist layout per project

Tool API

* Add tool API to list sessions
* Add tool API to read session output
* Add tool API to send input to session
* Add tool API to set session status
* Add tool API to list projects
* Add tool API to read and write project settings
* Allow agents to register status
* Allow agents to request attention
* Add authentication for tool API

Tickets and workflows

* Add ticket provider protocol
* Add todo.md ticket provider
* Add GitHub issues ticket provider
* Allow assigning tickets to agents
* Add prompt snippets per project
* Add workflow snippets

Mobile and secondary UX

* Improve mobile monitoring view
