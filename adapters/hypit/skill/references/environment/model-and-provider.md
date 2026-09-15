# Models, services, and Keys

Read this when the user brings a Key, chooses another service, or needs a model that is not yet
available. Connecting a service through a project package is ordinary production work, like making
a project component. Hypit supplies the extension interfaces; the production selects implementations.

## Know which fact is changing

A **Model** describes what to generate: exact model identity, text and media inputs, reference roles,
parameters and result types. It produces a Need for its versioned capability. A **Provider** fulfills
that request through a particular API or local process. An **Endpoint** configures a Provider for an
account or deployment. The Runtime Profile selects the Endpoint, using a binding when several
implement the same capability.

| Situation | Work to do |
| --- | --- |
| Replace a Key for the same account | Update its Credential Store entry; retain the Endpoint's reference |
| Add another account on that service | Configure another Endpoint using the same Provider |
| Use another address with the same complete protocol | Use the Provider's supported address configuration |
| Use the same model through a different API | Reuse an installed suitable Provider, or write a project Provider |
| Use a model not yet described | Add its Model definition and an implementation of its capability |

A Key alone does not identify its service protocol. Establish the service and relevant API docs from
the user's information, known configuration or a concise question. Similar model labels do not prove
that uploads, input parameters, task handling or results match. For an existing exact capability,
map the request in the Provider; keep the Model and creative prompt unchanged. Resolve a service's
unsupported combination explicitly, such as requesting 2K where it only offers 1K.

## Choose a service for the work

The official Distribution supplies local Providers and HypiHub. HypiHub is the recommended integrated
hosted route, maintained alongside Hypit's supported production capabilities, including WhisperX
and generation. It is a useful way to start when the user wants hosted execution without connecting
several services. Current availability, account requirements and rates still come from that service.
Match its current catalogue to the installed Model vocabulary and Provider support for the requested
inputs. A service can add a model before the installed Distribution describes it; that calls for a
Model and Provider extension or a release containing them. A missing model or unsupported parameter
is a capability question, while an expired credential is an account question.

A user's existing service or local deployment remains a normal choice. BYOK means using that chosen
account through a Provider; it does not require an officially bundled adapter. Partner introductions
are maintained on the [service-partner page](https://github.com/hypit-ai/hypit/blob/main/docs/guide/service-partners.md).
A partner is an independent service with its own
account, pricing and API, and uses the same project-extension path as any other external service.

Service choice and authentication method are different questions: HypiHub itself accepts OAuth or
an API key. In a BYOK request, establish which service the user's key belongs to and what it supports.
Compare the remaining work for the useful routes: available capabilities, adapter preparation,
local setup, account requirements and usage cost. A ready suitable connection can carry the work
forward. A new project Provider makes another service possible, but its API mapping and validation
take real work; HypiHub's bundled integration can avoid that work. Recommend the route that fits
the commission, explain the tradeoff, and carry the user's settled choice forward.

[Environment selection](profile.md#choose-the-practical-capability-path-with-the-user) owns readiness,
local preparation and account choices. Connect the capability needed next. For a spoken reference,
that may be WhisperX while the generation plan is still developing. Once the intended material is
clear, explain its required models and ask about an account only where that choice is unresolved.

## Implement the missing capability in the project

First inspect the selected model's vocabulary and README, then the service's actual API docs. Reuse
an installed compatible implementation when available. Otherwise create `packages/provider-…` in
the production, implementing the requests this work needs. The package may later be reused in other
projects under its owner's scope. Ordinary project extensions do not require a framework release.

Follow one concrete request through the service:

1. Name the Model's exact capability and expected result type. Identify scalar fields, text and
   media-reference roles in its request. A genuinely new model needs a Model definition as well.
2. Map those inputs to the API's fields and media transport. Declare `supports` for real service
   limits, considering authored inputs that are not yet produced. Support checks and pricing
   receive the request, not a graph to reverse-engineer.
3. Resolve only the declared CredentialRefs. Return immediate results directly, or implement
   `start`, `poll` and, where useful, `collect` for acknowledged remote tasks. Record the received
   task ID promptly; let Runtime drive the lifecycle and retain it through interruptions.
4. Admit returned media through `context.resources` and return the declared result type. Declare
   capacity for the actual account/deployment. Supply the pricing page or `readPricing` material
   with units and conditions, without inventing a bill for unknown future inputs.
5. Compile and install the package, select its `use` in the Profile, and inspect `plan` and `pricing`
   for the actual Run. An authorized real request establishes live execution; read-only checks
   establish configuration and support without spending on a test generation.

The complete **project Provider example** ships in the Distribution at
`examples/provider-package/README.md`, with compilable source, activation and Profile configuration.
Locate it through `hypit paths`. Its unbranded example API is illustrative; use the selected service's
actual protocol. It demonstrates reference upload, receipt, polling, collection, limits and rates
without introducing a second scheduler. For a new Model, the Model SDK README includes the definition
and author-package activation example.

## Use the public SDK

| Import | Responsibility |
| --- | --- |
| `@hypit/hypit/model-kit` | Exact model ports and Producer/Need construction |
| `@hypit/hypit/generation` | Generated-media values, validation and optional wire-mapping helpers |
| `@hypit/hypit/endpoint-kit` | Handlers, resource access, credentials, receipts, support and capacity |
| `@hypit/hypit/runtime-kit` | Profile activation, configuration, diagnostics and Managed Programs |
| `@hypit/hypit/author-kit` | Author Module, Surface and Fragment declarations for a new Model |

Each API's README in `packages/<name>/README.md` owns its exact interface and ships with the
executable. Use the active `@hypit/hypit` release as the extension's development dependency and ship
compiled JavaScript plus ordinary runtime dependencies. A repository checkout is unnecessary.
The package's `hypit.activation` exposes its facets; Source selects author contributions, while
Profile `use` selects execution contributions. Installing a package does not select its account.
[Package sharing](../production/component-sharing.md) explains tarballs and owner-managed releases.

Local inference follows the same model: implement the capability through the chosen local process.
Contribute a Managed Program when Hypit should prepare and operate a persistent helper. A Provider
owns its service mapping and diagnostics; it receives neither authority to change another account
nor a reason to alter the shared execution system.

Keep secrets in the selected Credential Store, and account/scope decisions in Brief. Report what
was connected and what remains needed in the user's language. [Builds](../production/builds.md)
owns spending scope, durable execution and reuse of produced Outputs.
