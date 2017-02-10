package io.buoyant.interpreter

// import com.twitter.conversions.time._
import com.fasterxml.jackson.annotation.JsonIgnore
import com.twitter.finagle._
import com.twitter.finagle.buoyant.{H2, TlsClientPrep}
import com.twitter.finagle.naming.NameInterpreter
import com.twitter.logging.Logger
import io.buoyant.namer.{InterpreterConfig, InterpreterInitializer}
import io.buoyant.interpreter.mesh.Client
import scala.util.control.NoStackTrace

/**
 * The namerd interpreter offloads the responsibilities of name
 * resolution to the namerd service via the namerd streaming gRPC API.
 * Any namers configured in this linkerd are not used.
 */
class MeshInterpreterInitializer extends InterpreterInitializer {
  val configClass = classOf[MeshInterpreterConfig]
  override def configId: String = "io.l5d.mesh"
}

object MeshInterpreterInitializer extends MeshInterpreterInitializer

case class MeshInterpreterConfig(
  dst: Option[Path],
  namespace: Option[String],
  tls: Option[MeshClientTlsConfig]
) extends InterpreterConfig {

  @JsonIgnore
  private[this] val log = Logger.get()

  // @JsonIgnore
  // val defaultRetry = Retry(5, 10.minutes.inSeconds)

  @JsonIgnore
  override val experimentalRequired = true

  /**
   * Construct a namer.
   */
  @JsonIgnore
  def newInterpreter(params: Stack.Params): NameInterpreter = {
    val name = dst match {
      case None => throw new IllegalArgumentException("`dst` is a required field")
      case Some(dst) => Name.Path(dst)
    }
    val label = MeshInterpreterInitializer.configId

    //val Retry(baseRetry, maxRetry) = retry.getOrElse(defaultRetry)
    //val backoffs = Backoff.exponentialJittered(baseRetry.seconds, maxRetry.seconds)

    val client = H2.client
      .withParams(H2.client.params ++ params)
      .transformed(tlsTransformer)
      .newService(name, label)

    Client(namespace.getOrElse("default"), client)
  }

  @JsonIgnore
  private[this] val tlsTransformer: Stack.Transformer = tls match {
    case None =>
      new Stack.Transformer {
        def apply[Req, Rep](stack: Stack[ServiceFactory[Req, Rep]]): Stack[ServiceFactory[Req, Rep]] = stack
      }

    case Some(MeshClientTlsConfig(Some(true), _, _)) =>
      new Stack.Transformer {
        private[this] def prep[Req, Rep] = TlsClientPrep.insecure[Req, Rep]
        override def apply[Req, Rep](underlying: Stack[ServiceFactory[Req, Rep]]) =
          prep[Req, Rep] +: underlying
      }

    case Some(MeshClientTlsConfig(_, Some(cn), certs)) =>
      new Stack.Transformer {
        private[this] def prep[Req, Rep] = TlsClientPrep.static[Req, Rep](cn, certs)
        override def apply[Req, Rep](underlying: Stack[ServiceFactory[Req, Rep]]) =
          prep[Req, Rep] +: underlying
      }

    case Some(MeshClientTlsConfig(Some(false) | None, None, _)) =>
      throw new IllegalArgumentException("io.l5d.mesh: tls is configured with validation but `commonName` is not set") with NoStackTrace
  }
}

case class MeshClientTlsConfig(
  disableValidation: Option[Boolean],
  commonName: Option[String],
  trustCerts: Seq[String] = Nil
)