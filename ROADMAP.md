# EmDash roadmap

The roadmap describes project-led work that EmDash has chosen to prioritise and coordinate. It is not a backlog of every request or accepted design, and it is not a gate for contributor-led work.

The first post-1.0 roadmap is being assembled. Until the public Roadmap Project is published, no item should be inferred to have a delivery date or release commitment.

## Planning horizons

- **Now:** actively being advanced.
- **Next:** intended within roughly the next six months.
- **Later:** an aim for roughly six to twelve months from now.
- **Unscheduled:** project-led work with no target window.

These horizons are planning signals, not release promises. Use exact dates or target releases only when delivery is sufficiently certain.

## Initiative stages

Each project-led initiative has a separate stage:

- **Discovery:** the project has selected a problem but has not chosen a solution.
- **Design:** a feature plan or RFC is being developed.
- **Ready:** the design is accepted and implementation can start.
- **Building:** implementation is active.
- **Paused:** the project is not currently advancing the initiative.
- **Shipped:** the intended outcome has landed.

An initiative can enter the roadmap during Discovery. Its tracking issue links research, Discussions, prototypes, design pull requests, and implementation pull requests as they become available.

## Tracking project-led work

Each initiative has a public tracking issue and an item in the public GitHub Roadmap Project. The tracking issue records:

- the intended outcome;
- why the project is prioritising it;
- its champion and Maintainer sponsor;
- its current horizon and stage;
- its next step; and
- links to related Discussions, accepted designs, issues, and implementation pull requests.

One initiative can produce several designs and implementation pull requests. Now and Next items require an active champion, a Maintainer sponsor, and a defined next step.

The Project Lead decides roadmap placement, including each initiative's horizon, after public reasoning and consultation. The initiative's champion keeps its stage current. Review the roadmap every few months and whenever priorities materially change.

## Contributor-led work

Accepting a design permits implementation. It does not make the work a project priority or promise it for a release.

A contributor who proposes and intends to implement an accepted design can proceed without roadmap placement. An accepted design without an implementer remains in the [proposals index](proposals/README.md) and enters the roadmap only if the project later decides to drive the work.

## Next major release

Deprecated behavior and APIs stay supported through 1.x and are removed in the next major release. The [deprecations tracking issue](https://github.com/emdash-cms/emdash/issues/3917) lists them. Removing them needs an RFC before the next major.
