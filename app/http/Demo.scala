package lila.app
package http

import play.api.mvc.{ Cookie, Filter, RequestHeader, Result, Results }

import lila.common.HTTPRequest
import lila.core.config.NetConfig
import lila.db.dsl.*
import lila.user.BSONHandlers.given

final class Demo(
    net: NetConfig,
    userRepo: lila.user.UserRepo,
    securityApi: lila.security.SecurityApi,
    lilaCookie: lila.security.LilaCookie
)(using Executor):

  private val logger = lila.log("security")

  private val users: Option[Fu[IndexedSeq[Me]]] = net.demo.option:
    logger.info("Demo mode enabled; loading demo users")
    userRepo.coll
      .find(userRepo.trollSelect.apply(true))
      .sort($sort.asc("username"))
      .cursor[UserModel]()
      .listAll()
      .map(_.map(Me(_)).toIndexedSeq)
      .recover { case error =>
        logger.error("Could not load demo users", error)
        IndexedSeq.empty
      }

  def enabled = net.demo

  def userFor(req: RequestHeader): Fu[Option[Me]] =
    users.fold(fuccess(none)):
      _.map: users =>
        Option.when(users.nonEmpty)(
          users(Math.floorMod(HTTPRequest.ipAddress(req).value.hashCode, users.size))
        )

  def sessionCookie(req: RequestHeader): Fu[Option[Cookie]] =
    if !enabled then fuccess(none)
    else
      securityApi
        .hasAuthentication(req)
        .flatMap:
          if _ then fuccess(none)
          else
            userFor(req).flatMap:
              _.fold(fuccess(none)): me =>
                securityApi
                  .saveDemoAuthentication(me.userId)(using req)
                  .map: sessionId =>
                    lilaCookie
                      .withSession(remember = true)(_ + (securityApi.sessionIdKey -> sessionId.value))(using
                        req
                      )
                      .some

final class DemoFilter(demo: Demo)(using val mat: org.apache.pekko.stream.Materializer)(using Executor)
    extends Filter:
  def apply(handle: RequestHeader => Fu[Result])(req: RequestHeader): Fu[Result] =
    if demo.enabled && isSignup(req) then fuccess(Results.NotFound)
    else
      handle(req).flatMap: result =>
        demo.sessionCookie(req).map(_.fold(result)(result.withCookies(_)))

  private def isSignup(req: RequestHeader): Boolean =
    req.path == "/signup" || req.path.startsWith("/signup/") || req.path.matches("/[a-z]{2,3}/signup")
